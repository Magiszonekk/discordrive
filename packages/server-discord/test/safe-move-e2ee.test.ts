// Moving into and out of the Safe (e2ee instance): the file is sent again under a new key — whoever had the
// account key may have kept the old file key — and the old copy deleted for good (its pieces go 30 days later).
import { mkdtempSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, SafeFileGoneError, SafeStore, SafeTree, createAccountHttp, decodeManifestRef, generateDeviceKey, memorySource, newAccountKey, releasedUploads, safeChildren, safeTreeOf, type ByteSink, type SafeTreeState } from "@ddv4/metadata-client";
import { GALLERY_ID } from "@ddv4/sync-core";
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
  const dir = mkdtempSync(join(tmpdir(), "ddn-safe-move-"));
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
  await hooks.add(POOL, fake.addWebhook("1550000000000000181").url, transport);
  const db = (srv as unknown as { db: { prepare(q: string): { get(...x: unknown[]): unknown } } }).db;
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const c = await createAccountHttp(url, dk, key);
  const api = new HttpApi({ baseUrl: url, accountId: c.accountId, deviceId: c.deviceId, key: dk, instanceId: c.instanceId });
  const blobs = new ServerBlobStore(api, { fetchCdn: async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()) });
  const client = new DriveClient({ device: { id: c.deviceId, name: "laptop" }, arbiter: new EncryptedArbiter(new OpCodec(key, c.accountId), api), blobs, chunkSize: 64 * 1024, concurrency: 2 });
  const tree = new SafeTree(new SafeStore<SafeTreeState>(api, key, c.accountId), { id: c.deviceId, name: "laptop" }, { pieces: { kind: "instance", api }, now: () => clock.t });
  const state = (u: string) => (db.prepare("SELECT state FROM s_uploads WHERE account_id = ? AND upload_id = ?").get(c.accountId, u) as { state: string } | undefined)?.state;
  const liveBlobs = (u: string) => (db.prepare("SELECT count(*) AS n FROM s_blobs WHERE account_id = ? AND upload_id = ? AND deleted_at IS NULL").get(c.accountId, u) as { n: number }).n;
  const reopen = () => new SafeStore<SafeTreeState>(api, key, c.accountId).unlock(PW);
  return { clock, ext, client, tree, state, liveBlobs, db, reopen };
}

const names = (c: DriveClient, parent = "root") => c.list(parent).map((x) => x.name);

describe("e2ee: moving into and out of the Safe", () => {
  it("a folder with files into the Safe: sent again under new keys, gone from the account, the old pieces deleted after 30 days", async () => {
    const S = await setup();
    const c = S.client;
    await c.commitOp({ type: "create", kind: "folder", nodeId: "fold-dokumenty", parentId: "root", name: "Dokumenty" }, "mkdir");
    await c.commitOp({ type: "create", kind: "folder", nodeId: "fold-puste-001", parentId: "fold-dokumenty", name: "Puste" }, "mkdir");
    const d1 = new Uint8Array(randomBytes(64 * 1024 * 2 + 11));
    const d2 = new Uint8Array(randomBytes(500));
    const f1 = await c.upload(memorySource(d1), "umowa.pdf", "fold-dokumenty");
    const f2 = await c.upload(memorySource(d2), "notatka.txt", "root");
    await c.upload(memorySource(new Uint8Array(randomBytes(10))), "zostaje.txt", "root");
    let u = await S.tree.create(PW, FAST);
    const progress: number[] = [];
    const r = await S.tree.moveIn(u, c, ["fold-dokumenty", f2.nodeId], "root", { onProgress: (b) => progress.push(b) });
    u = r.safe;
    expect(r.files).toBe(2);
    expect(r.bytes).toBe(d1.byteLength + d2.byteLength);
    expect(progress.at(-1)).toBe(d1.byteLength + d2.byteLength);
    // The account: only what was not moved (nothing in its trash either).
    await c.pull();
    expect(names(c)).toEqual(["zostaje.txt"]);
    expect([...c.store.allNodes()].filter((n) => n.trashed).length).toBe(0);
    // The Safe: the folder with its empty subfolder and the file, the other file at the root.
    expect(safeChildren(u, "root").map((n) => n.name)).toEqual(["Dokumenty", "notatka.txt"]);
    const docs = safeChildren(u, "root")[0]!.id;
    expect(safeChildren(u, docs).map((n) => n.name)).toEqual(["Puste", "umowa.pdf"]);
    // New pieces under a new key: another upload, another manifest, another file key.
    const t = safeTreeOf(u);
    const moved = [...t.allNodes()].find((n) => n.name === "umowa.pdf")!.content!;
    expect(moved.uploadId).not.toBe(f1.version.uploadId);
    expect(decodeManifestRef(moved.manifestRef).k).not.toBe(decodeManifestRef(f1.version.manifestRef).k);
    expect(moved.plaintextSha256).toBe(f1.version.plaintextSha256);
    const s = sink();
    await S.tree.download(u, c, [...t.allNodes()].find((n) => n.name === "umowa.pdf")!.id, s);
    expect(sha(s.data())).toBe(sha(d1));
    // The account's old copies: released, deleted from Discord 30 days later.
    // (the web client reports them in the background; here directly)
    const rel = releasedUploads(c.store);
    expect(rel.map((x) => x.uploadId).sort()).toEqual([f1.version.uploadId, f2.version.uploadId].sort());
    const http = (c.blobs as unknown as { api: HttpApi }).api;
    await http.json("POST", "/v1/uploads/released", { uploads: rel.map(({ uploadId, at }) => ({ uploadId, at })) });
    S.clock.t += FRAGMENT_RETENTION_MS + 60_000;
    await S.ext.tick();
    expect(S.liveBlobs(f1.version.uploadId)).toBe(0);
    expect(S.liveBlobs(moved.uploadId)).toBe(4); // 3 fragments + manifest
  }, 60_000);

  it("an interrupted move started again fills the folder already in the Safe (no \"Teczka (2)\"); the plan counts the trashed files inside", async () => {
    const S = await setup();
    const c = S.client;
    await c.commitOp({ type: "create", kind: "folder", nodeId: "fold-teczka-01", parentId: "root", name: "Teczka" }, "mkdir");
    for (const n of ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]) await c.upload(memorySource(new Uint8Array(randomBytes(300))), n, "fold-teczka-01");
    const junk = await c.upload(memorySource(new Uint8Array(randomBytes(100))), "w-koszu.txt", "fold-teczka-01");
    await c.commitOp({ type: "trash", nodeId: junk.nodeId }, "trash");
    expect(SafeTree.moveInPlan(c.store, ["fold-teczka-01"])).toEqual({ bytes: 1200, files: 4, trashedInside: 1 });
    let u = await S.tree.create(PW, FAST);
    // Stopped while the third file goes.
    const ac = new AbortController();
    const first = await S.tree
      .moveIn(u, c, ["fold-teczka-01"], "root", { signal: ac.signal, onProgress: (_b, _t, f) => void (f === "c.pdf" && ac.abort()) })
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    u = await S.reopen();
    expect(safeChildren(u, "root").map((n) => n.name)).toEqual(["Teczka"]);
    await c.pull();
    const left = c.list("fold-teczka-01").map((x) => x.name);
    expect(left.length).toBeGreaterThan(0);
    const r = await S.tree.moveIn(u, c, ["fold-teczka-01"], "root");
    u = r.safe;
    expect(safeChildren(u, "root").map((n) => n.name)).toEqual(["Teczka"]);
    expect(safeChildren(u, safeChildren(u, "root")[0]!.id).map((n) => n.name)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    await c.pull();
    expect(names(c)).toEqual([]);
  }, 60_000);

  it("a file of the Safe whose pieces are gone (a restored revision, an old database): SafeFileGoneError, not a raw 404", async () => {
    const S = await setup();
    const c = S.client;
    let u = await S.tree.create(PW, FAST);
    const up = await S.tree.upload(u, c, memorySource(new Uint8Array(randomBytes(2000))), "stary.pdf", "root");
    u = up.safe;
    (S.db as unknown as { prepare(q: string): { run(...x: unknown[]): unknown } }).prepare("DELETE FROM s_blobs WHERE upload_id = ?").run(up.version.uploadId);
    const e = await S.tree.download(u, c, up.nodeId, sink()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SafeFileGoneError);
    expect((e as SafeFileGoneError).fileName).toBe("stary.pdf");
  }, 60_000);

  it("out of the Safe into a Gallery album: a new upload in the account, gone from the Safe (its pieces let go)", async () => {
    const S = await setup();
    const c = S.client;
    let u = await S.tree.create(PW, FAST);
    const data = new Uint8Array(randomBytes(64 * 1024 + 5));
    const inSafe = await S.tree.upload(u, c, memorySource(data), "zdjecie.jpg", "root", { takenAt: Date.UTC(2024, 6, 1) });
    u = inSafe.safe;
    // An album in the Gallery (rules 4: the Gallery's root appears with the first such entry).
    await c.commitOp({ type: "create", kind: "folder", nodeId: "album-wakacje", parentId: GALLERY_ID, name: "Wakacje", space: "gallery" }, "mkdir");
    const r = await S.tree.moveOut(u, c, [inSafe.nodeId], "album-wakacje");
    u = r.safe;
    expect(safeChildren(u, "root")).toEqual([]);
    expect(S.state(inSafe.version.uploadId)).toBe("released");
    await c.pull();
    expect(names(c, "album-wakacje")).toEqual(["zdjecie.jpg"]);
    const n = c.store.getNode(c.list("album-wakacje")[0]!.id)!;
    expect(n.content!.uploadId).not.toBe(inSafe.version.uploadId);
    expect(decodeManifestRef(n.content!.manifestRef).k).not.toBe(decodeManifestRef(inSafe.version.manifestRef).k);
    expect(await c.takenAt(n.content!.manifestRef)).toBe(Date.UTC(2024, 6, 1));
    const s = sink();
    await c.download(n.id, s);
    expect(sha(s.data())).toBe(sha(data));
  }, 60_000);
});
