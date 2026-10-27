// Files in the Safe in e2ee: the pieces go through the instance, the commit into the Safe (not the log). The
// instance must keep the upload (not reap it as abandoned) and release it when the Safe lets the file go.
import { mkdtempSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, SafeStore, SafeTree, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, safeChildren, type ByteSink, type SafeTreeState } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, InstanceHooks, POOL, loadInstanceKey } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => new Uint8Array(Buffer.concat(parts)) };
}

describe("e2ee: files in the Safe", () => {
  it("upload through the instance into the Safe; nothing in the log; not reaped as abandoned; readable from another device", async () => {
    let t = Date.UTC(2026, 9, 27);
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
    const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode: "e2ee", rateLimits: false, leaseMs: 60_000, now: () => t, extensions: [{ name: "hooks", init: (s) => void (hooks = new InstanceHooks(s.db, ikey, s.clock)) }, ext] });
    const { url } = await srv.listen(0);
    cleanups.push(() => srv.close());
    await hooks.add(POOL, fake.addWebhook("1550000000000000171").url, transport);

    const key = newAccountKey();
    const dev = async (r?: { accountId: string; api: HttpApi }) => {
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
      return { api, accountId, client };
    };
    const A = await dev();
    const tree = new SafeTree(new SafeStore<SafeTreeState>(A.api, key, A.accountId), { id: "dev-A", name: "laptop" });
    let u = await tree.create("correct horse battery staple", { memoryKiB: 19456, iterations: 2, parallelism: 1 });
    const data = new Uint8Array(randomBytes(64 * 1024 * 2 + 5));
    const up = await tree.upload(u, A.client, memorySource(data), "umowa-poufna.pdf");
    u = up.safe;
    expect(safeChildren(u, "root").map((n) => n.name)).toEqual(["umowa-poufna.pdf"]);
    expect((srv as unknown as { db: { prepare(q: string): { get(...x: unknown[]): { n: number } } } }).db.prepare("SELECT count(*) AS n FROM log WHERE account_id = ?").get(A.accountId).n).toBe(0);

    // Long after the lease and the idle time: the instance's cleanup must not take it (it is committed, in the Safe).
    t += 2 * 3600_000;
    expect((await ext.tick()).reaped).toBe(0);

    const B = await dev(A);
    const ub = await new SafeStore<SafeTreeState>(B.api, key, A.accountId).unlock("correct horse battery staple");
    const s = sink();
    await new SafeTree(new SafeStore<SafeTreeState>(B.api, key, A.accountId), { id: "dev-B", name: "phone" }).download(ub, B.client, up.nodeId, s);
    expect(sha(s.data())).toBe(sha(data));
  }, 60_000);
});
