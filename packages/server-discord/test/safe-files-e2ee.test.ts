// Files in the Safe in e2ee: the pieces go through the instance, the commit into the Safe (not the log). The
// instance must keep such an upload (not reap it as abandoned) and let it go when the Safe no longer uses it:
// a purge, a write that failed after the pieces were stored, a restored revision without the file.
import { mkdtempSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, SAFE_ORPHAN_GRACE_MS, SafeStore, SafeTree, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, safeChildren, type ByteSink, type SafeTreeState } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, FRAGMENT_RETENTION_MS, InstanceHooks, POOL, loadInstanceKey } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => new Uint8Array(Buffer.concat(parts)) };
}
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const PW = "correct horse battery staple";

async function setup() {
  const clock = { t: Date.UTC(2026, 9, 27) };
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "ddn-safe-e2ee-"));
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const ikey = loadInstanceKey(join(dir, "instance.key"));
  let hooks!: InstanceHooks;
  const ext = new BlobsExtension({
    get hooks() {
      return hooks;
    },
    sender: new DiscordSender({ transport, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) }),
    tickMs: 0,
    cdnOrigins: [origin],
  } as never);
  const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode: "e2ee", rateLimits: false, leaseMs: 60_000, now: () => clock.t, extensions: [{ name: "hooks", init: (s) => void (hooks = new InstanceHooks(s.db, ikey, s.clock)) }, ext] });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  await hooks.add(POOL, fake.addWebhook("1550000000000000171").url, transport);
  const db = (srv as unknown as { db: { prepare(q: string): { get(...x: unknown[]): unknown } } }).db;
  const key = newAccountKey();
  const dev = async (r?: { accountId: string; api: HttpApi }, slotApi?: (api: HttpApi) => HttpApi) => {
    const dk = await generateDeviceKey();
    let accountId: string;
    let api: HttpApi;
    if (!r) {
      const c = await createAccountHttp(url, dk, key);
      accountId = c.accountId;
      api = new HttpApi({ baseUrl: url, accountId, deviceId: c.deviceId, key: dk, instanceId: c.instanceId });
    } else {
      accountId = r.accountId;
      const { deviceId } = await r.api.addDevice(dk.publicKey);
      api = new HttpApi({ baseUrl: url, accountId, deviceId, key: dk });
    }
    const blobs = new ServerBlobStore(api, { fetchCdn: async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()) });
    const client = new DriveClient({ device: { id: "d", name: "d" }, arbiter: new EncryptedArbiter(new OpCodec(key, accountId), api), blobs, chunkSize: 64 * 1024, concurrency: 2 });
    const store = new SafeStore<SafeTreeState>(slotApi ? slotApi(api) : api, key, accountId);
    const tree = new SafeTree(store, { id: "dev", name: "laptop" }, { pieces: { kind: "instance", api }, now: () => clock.t });
    return { api, accountId, client, store, tree };
  };
  const state = (accountId: string, u: string) => (db.prepare("SELECT state FROM s_uploads WHERE account_id = ? AND upload_id = ?").get(accountId, u) as { state: string } | undefined)?.state;
  const liveBlobs = (accountId: string, u: string) => (db.prepare("SELECT count(*) AS n FROM s_blobs WHERE account_id = ? AND upload_id = ? AND deleted_at IS NULL").get(accountId, u) as { n: number }).n;
  const logCount = (accountId: string) => (db.prepare("SELECT count(*) AS n FROM log WHERE account_id = ?").get(accountId) as { n: number }).n;
  return { clock, fake, ext, dev, state, liveBlobs, logCount };
}

describe("e2ee: files in the Safe", () => {
  it("upload through the instance into the Safe; nothing in the log; not reaped as abandoned; readable from another device", async () => {
    const S = await setup();
    const A = await S.dev();
    let u = await A.tree.create(PW, FAST);
    const data = new Uint8Array(randomBytes(64 * 1024 * 2 + 5));
    const up = await A.tree.upload(u, A.client, memorySource(data), "umowa-poufna.pdf");
    u = up.safe;
    expect(safeChildren(u, "root").map((n) => n.name)).toEqual(["umowa-poufna.pdf"]);
    expect(S.logCount(A.accountId)).toBe(0);
    // Long after the lease and the idle time: the instance's cleanup must not take it (it is committed, in the Safe).
    S.clock.t += 2 * 3600_000;
    expect((await S.ext.tick()).reaped).toBe(0);
    // Nor the Safe's cleanup: the Safe uses it.
    expect((await A.tree.cleanup(u)).released).toBe(0);
    expect(S.state(A.accountId, up.version.uploadId)).toBe("committed");
    const B = await S.dev(A);
    const ub = await B.store.unlock(PW);
    const s = sink();
    await B.tree.download(ub, B.client, up.nodeId, s);
    expect(sha(s.data())).toBe(sha(data));
  }, 60_000);

  it("deleted for good in the Safe → released at once, the pieces deleted from Discord 30 days later; the state forgets it", async () => {
    const S = await setup();
    const A = await S.dev();
    let u = await A.tree.create(PW, FAST);
    const up = await A.tree.upload(u, A.client, memorySource(new Uint8Array(randomBytes(64 * 1024 + 9))), "skan.jpg");
    u = up.safe;
    const x = up.version.uploadId;
    expect(S.liveBlobs(A.accountId, x)).toBe(3);
    u = (await A.tree.trash(u, up.nodeId)).safe;
    expect(S.state(A.accountId, x)).toBe("committed"); // in the Safe's trash: still a file of the Safe
    u = (await A.tree.commit(u, { type: "purge", nodeId: up.nodeId })).safe;
    expect(S.state(A.accountId, x)).toBe("released");
    // The state keeps neither the note nor the released record.
    expect(u.state.gone ?? []).toEqual([]);
    expect(u.state.tree.uploads.map((r) => r.id)).not.toContain(x);
    S.clock.t += FRAGMENT_RETENTION_MS - 60_000;
    expect((await S.ext.tick()).purged).toBe(0);
    S.clock.t += 120_000;
    expect((await S.ext.tick()).purged).toBe(1);
    expect(S.state(A.accountId, x)).toBe("purged");
    expect(S.liveBlobs(A.accountId, x)).toBe(0);
    expect(S.fake.messages.size).toBe(0);
  }, 60_000);

  it("the Safe write fails after the pieces are stored → not reaped, let go by a later cleanup after the grace time, deleted 30 days later", async () => {
    const S = await setup();
    let failPut = false;
    // A device whose Safe writes fail (the slot unreachable at that moment): after finalize.
    const A = await S.dev(undefined, (api) =>
      new Proxy(api, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p === "putSlot") return (...a: unknown[]) => (failPut ? Promise.reject(new Error("instance unreachable")) : (v as (...x: unknown[]) => unknown).apply(t, a));
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    );
    const u = await A.tree.create(PW, FAST);
    failPut = true;
    const before = new Set(S.fake.messages.keys());
    await expect(A.tree.upload(u, A.client, memorySource(new Uint8Array(randomBytes(64 * 1024 + 1))), "nieudany.pdf")).rejects.toThrow(/unreachable/);
    failPut = false;
    const orphan = [...S.fake.messages.keys()].filter((k) => !before.has(k));
    expect(orphan.length).toBe(3);
    const rows = (await A.api.json<{ uploads: { uploadId: string; state: string }[] }>("GET", "/v1/uploads/outside")).body.uploads;
    expect(rows.length).toBe(1);
    const x = rows[0]!.uploadId;
    // Inside the grace time: another device's write may still be on its way, so nothing is let go.
    const B = await S.dev(A);
    const ub = await B.store.unlock(PW);
    S.clock.t += SAFE_ORPHAN_GRACE_MS - 60_000;
    expect((await B.tree.cleanup(ub)).released).toBe(0);
    expect((await S.ext.tick()).reaped).toBe(0);
    S.clock.t += 120_000;
    expect((await B.tree.cleanup(ub)).released).toBe(1);
    expect(S.state(A.accountId, x)).toBe("released");
    S.clock.t += FRAGMENT_RETENTION_MS + 60_000;
    await S.ext.tick();
    expect(S.liveBlobs(A.accountId, x)).toBe(0);
    for (const k of orphan) expect(S.fake.messages.has(k)).toBe(false);
  }, 60_000);

  it("a restored revision with a file deleted meanwhile: the file is kept (back from released), readable; the files it lacks are let go", async () => {
    const S = await setup();
    const A = await S.dev();
    let u = await A.tree.create(PW, FAST);
    const data = new Uint8Array(randomBytes(64 * 1024 + 3));
    const a = await A.tree.upload(u, A.client, memorySource(data), "a.pdf");
    u = a.safe;
    const withA = u.revision;
    u = (await A.tree.trash(u, a.nodeId)).safe;
    u = (await A.tree.commit(u, { type: "purge", nodeId: a.nodeId })).safe;
    const b = await A.tree.upload(u, A.client, memorySource(new Uint8Array(randomBytes(100))), "b.pdf");
    u = b.safe;
    expect(S.state(A.accountId, a.version.uploadId)).toBe("released");
    // Back to the revision with a.pdf (and without b.pdf).
    u = await A.tree.restoreRevision(withA, { password: PW }, u);
    const r = await A.tree.cleanup(u);
    expect(r.kept).toBe(1);
    expect(r.released).toBe(1);
    expect(S.state(A.accountId, a.version.uploadId)).toBe("committed");
    expect(S.state(A.accountId, b.version.uploadId)).toBe("released");
    S.clock.t += FRAGMENT_RETENTION_MS + 60_000;
    await S.ext.tick();
    const s = sink();
    await A.tree.download(r.safe, A.client, a.nodeId, s);
    expect(sha(s.data())).toBe(sha(data));
    expect(S.liveBlobs(A.accountId, b.version.uploadId)).toBe(0);
  }, 60_000);
});
