// Removing a channel on the e2ee/plain instance (zlecenie 2026-10-13-webhooki p. 1): per-channel
// stats, critical detection (pointer, segments, backfill of an older chain), retire, move and
// remove (resumable, aliases for the clients' old placements, share links, chain rewrite), remove
// anyway (computed unavailability, re-paste, bot recovery), plain reads after a move, pool scope.
// Real DdnServer + fake Discord + the client core; the clock is driven.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, openShare, prepareShareWith, sha256Hex, type ByteSink } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { PlainArbiter, PlainOpCodec } from "@ddv4/metadata-client/plain-ops";
import { DdnServer, FakeDiscord, type BotRefresher } from "@ddv4/metadata-client/node";
import { ChannelStore, MOVE_RETRY_MS, POOL, rebuildAccountLog, serverBlobsMode } from "../src/index.js";
import { PlainExtension } from "../src/plain-ext.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

function bytes(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return b;
}
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => Buffer.concat(parts) };
}
function fakeBot(fake: FakeDiscord, origin: string): BotRefresher {
  fake.botToken = "fake-bot";
  return {
    async refresh(urls) {
      const r = await fetch(`${origin}/api/v10/attachments/refresh-urls`, { method: "POST", headers: { authorization: "Bot fake-bot", "content-type": "application/json" }, body: JSON.stringify({ attachment_urls: urls }) });
      return ((await r.json()) as { refreshed_urls: { refreshed: string }[] }).refreshed_urls.map((x) => x.refreshed);
    },
  };
}

async function instance(o: { pool?: number; bot?: boolean; plain?: boolean } = {}) {
  const clock = { t: Date.UTC(2026, 9, 13, 12) };
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-chan-"));
  const bot = o.bot ? fakeBot(fake, origin) : null;
  const m = serverBlobsMode({ dataDir: dir, discordApiOrigin: origin, bot, cleanupTickMs: 0, snapshotTickMs: 0, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 50 }) });
  const plain = o.plain ? new PlainExtension({ dataDir: dir, blobs: m.blobs }) : null;
  const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode: o.plain ? "plain" : "e2ee", rateLimits: false, now: () => clock.t, extensions: [...m.extensions, ...(plain ? [plain] : [])], bot: m.shareRefresher, cdnOrigins: [origin] });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const pool = [];
  for (let i = 0; i < (o.pool ?? 2); i++) {
    const h = fake.addWebhook(String(1550000000000000700n + BigInt(i)));
    await m.hooks().add(POOL, h.url, transport);
    pool.push(h);
  }
  return { clock, fake, origin, url, srv, m, plain, pool, dir, transport, store: () => m.blobs.channelStore };
}
type Inst = Awaited<ReturnType<typeof instance>>;

async function account(I: Inst, plain = false) {
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const r = await createAccountHttp(I.url, dk, key);
  const api = new HttpApi({ baseUrl: I.url, accountId: r.accountId, deviceId: r.deviceId, key: dk });
  const blobs = new ServerBlobStore(api);
  const client = new DriveClient({
    device: { id: r.deviceId, name: "t" },
    arbiter: plain ? new PlainArbiter(new PlainOpCodec(r.accountId), api) : new EncryptedArbiter(new OpCodec(key, r.accountId), api),
    blobs,
    chunkSize: 64 * 1024,
    concurrency: 3,
    now: () => I.clock.t,
  });
  return { api, client, blobs, accountId: r.accountId, key };
}
type Acct = Awaited<ReturnType<typeof account>>;

/** Add an own channel to an account; returns the fake's webhook. */
async function ownChannel(I: Inst, A: Acct, channelId: string, label: string) {
  const h = I.fake.addWebhook(channelId);
  await A.api.json("POST", "/v1/channels", { url: h.url, label });
  return h;
}

async function sameBytes(A: Acct, nodeId: string, data: Uint8Array) {
  const s = sink();
  await A.client.download(nodeId, s);
  return (await sha256Hex(s.data())) === (await sha256Hex(data));
}

interface Row {
  id: string;
  label: string;
  retired: boolean;
  critical: boolean;
  criticalWhat: string[];
  files: number;
  bytes: number;
}
const channels = async (A: Acct) =>
  (await A.api.json<{ own: Row[]; using: string; removed: { id: string; how: string; unavailableFiles: number }[]; move: { state: string; done: number; total: number } | null; botRecovery: boolean; usage: number }>("GET", "/v1/channels")).body;
const msgsOn = (I: Inst, webhookId: string) => [...I.fake.messages.values()].filter((m) => m.webhookId === webhookId).length;
const blobsOn = (I: Inst, webhookId: string) => Number((I.srv.db.prepare("SELECT count(*) AS n FROM s_blobs WHERE webhook_id = ? AND deleted_at IS NULL").get(webhookId) as { n: number }).n);

describe("channels: stats, critical, retire", () => {
  it("files/bytes per channel; the pointer's webhook is critical (pointer + segments); an older chain is indexed by the backfill walk", async () => {
    const I = await instance();
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000801", "X");
    const Y = await ownChannel(I, A, "1550000000000000802", "Y");
    const files = [bytes(64 * 1024 * 3 + 5, 1), bytes(1000, 2), bytes(64 * 1024 + 9, 3), bytes(77, 4)];
    for (const [i, d] of files.entries()) await A.client.upload(memorySource(d), `f${i}.bin`);
    I.clock.t += 120_000;
    expect(await I.m.snapshots.tick(true)).toBe(1);
    const c = await channels(A);
    const byId = new Map(c.own.map((r) => [r.id, r]));
    // Every blob of every file is on X or Y: the per-channel bytes add up to the stored ciphertext.
    const total = Number((I.srv.db.prepare("SELECT sum(size) AS s FROM s_blobs").get() as { s: number }).s);
    expect(byId.get(X.id)!.bytes + byId.get(Y.id)!.bytes).toBe(total);
    expect(byId.get(X.id)!.files + byId.get(Y.id)!.files).toBeGreaterThanOrEqual(4);
    const ptr = I.m.snapshots.location(A.accountId)!;
    const crit = byId.get(ptr.webhookId)!;
    expect(crit).toMatchObject({ critical: true, criticalWhat: ["pointer", "snapshots"] });
    const other = c.own.find((r) => r.id !== ptr.webhookId)!;
    expect(other).toMatchObject({ critical: false, criticalWhat: [] });
    // New segments go to the pointer's webhook only.
    await A.client.commitOp({ type: "create", kind: "folder", nodeId: "folderCCCCCCCCCCCCCCCCC", parentId: "root", name: "x" }, "mkdir");
    I.clock.t += 120_000;
    await I.m.snapshots.tick(true);
    const segHooks = I.srv.db.prepare("SELECT DISTINCT webhook_id FROM s_snap_objs WHERE account_id = ?").all(A.accountId) as { webhook_id: string }[];
    expect(segHooks.map((r) => r.webhook_id)).toEqual([ptr.webhookId]);
    expect(c.usage).toBeGreaterThan(total);
    // A chain written before s_snap_objs existed: the walk finds the same objects.
    const before = I.srv.db.prepare("SELECT message_id, webhook_id, kind FROM s_snap_objs ORDER BY message_id").all();
    I.srv.db.exec("DELETE FROM s_snap_objs; UPDATE s_snapshots SET objs_ok = 0");
    expect((await channels(A)).own.find((r) => r.id === ptr.webhookId)!.criticalWhat).toEqual(["pointer"]); // segments unknown until the walk
    expect(I.store().unindexed(A.accountId)).toEqual([A.accountId]);
    // The impact endpoint walks the chain before answering, so "critical" is complete.
    const imp = await A.api.json<{ critical: boolean; criticalWhat: string[] }>("GET", `/v1/channels/${ptr.webhookId}/impact`);
    expect(imp.body.criticalWhat).toEqual(["pointer", "snapshots"]);
    expect(I.srv.db.prepare("SELECT message_id, webhook_id, kind FROM s_snap_objs ORDER BY message_id").all()).toEqual(before);
  });

  it("retire: new blobs avoid it, its files still download, undo works; a critical channel and the last active one cannot be retired or removed", async () => {
    const I = await instance();
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000811", "X");
    const Y = await ownChannel(I, A, "1550000000000000812", "Y");
    const d1 = bytes(64 * 1024 * 4, 5);
    const f1 = await A.client.upload(memorySource(d1), "before.bin");
    expect(blobsOn(I, X.id)).toBeGreaterThan(0);
    expect(blobsOn(I, Y.id)).toBeGreaterThan(0);
    await A.api.json("POST", `/v1/channels/${Y.id}/retire`, { retired: true });
    const yBefore = I.fake.postsByChannel.get(Y.channelId);
    const d2 = bytes(64 * 1024 * 4, 6);
    const f2 = await A.client.upload(memorySource(d2), "after.bin");
    expect(I.fake.postsByChannel.get(Y.channelId)).toBe(yBefore); // nothing new on Y
    expect(await sameBytes(A, f1.nodeId, d1)).toBe(true); // still read
    expect(await sameBytes(A, f2.nodeId, d2)).toBe(true);
    const c = await channels(A);
    expect(c.own.find((r) => r.id === Y.id)!.retired).toBe(true);
    expect(c.using).toBe("own");
    // X is now the only active own channel: retiring it is allowed while the pool is behind it (the account then
    // posts to the pool, the same rule as move and remove anyway); it is undone right away.
    await A.api.json("POST", `/v1/channels/${X.id}/retire`, { retired: true });
    expect((await channels(A)).using).toBe("pool");
    await A.api.json("POST", `/v1/channels/${X.id}/retire`, { retired: false });
    await A.api.json("POST", `/v1/channels/${Y.id}/retire`, { retired: false });
    expect((await channels(A)).own.find((r) => r.id === Y.id)!.retired).toBe(false);
    // The pointer's webhook is critical: neither retire nor remove anyway.
    I.clock.t += 120_000;
    await I.m.snapshots.tick(true);
    const ptr = I.m.snapshots.location(A.accountId)!.webhookId;
    await expect(A.api.json("POST", `/v1/channels/${ptr}/retire`, { retired: true })).rejects.toMatchObject({ status: 409, code: "channel_critical" });
    await expect(A.api.json("DELETE", `/v1/channels/${ptr}`)).rejects.toMatchObject({ status: 409, code: "channel_critical" });
    const imp = (await A.api.json<{ critical: boolean; otherActive: number; files: number; moveBytes: number; moveEtaMs: number }>("GET", `/v1/channels/${ptr}/impact`)).body;
    expect(imp).toMatchObject({ critical: true, otherActive: 1 });
    expect(imp.moveBytes).toBeGreaterThan(0);
    expect(imp.moveEtaMs).toBeGreaterThan(0);
  });

  it("the only channel with no pool to fall back to: remove refused (need_other_channel); with the pool behind it, a non-critical own channel can go", async () => {
    const I = await instance({ pool: 0 });
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000821", "only");
    await A.client.upload(memorySource(bytes(500)), "a");
    await expect(A.api.json("DELETE", `/v1/channels/${X.id}`)).rejects.toMatchObject({ status: 409, code: "need_other_channel" });
    await expect(A.api.json("POST", `/v1/channels/${X.id}/move`, {})).rejects.toMatchObject({ status: 409, code: "need_other_channel" });
    await expect(A.api.json("POST", `/v1/channels/${X.id}/retire`, { retired: true })).rejects.toMatchObject({ status: 409, code: "need_other_channel" });
    const imp = (await A.api.json<{ otherActive: number; moveEtaMs: number | null }>("GET", `/v1/channels/${X.id}/impact`)).body;
    expect(imp).toMatchObject({ otherActive: 0, moveEtaMs: null });
    // check.ts's flow: pool present, own channel added and removed again (nothing critical on it).
    const J = await instance();
    const B = await account(J);
    const Z = await ownChannel(J, B, "1550000000000000822", "tmp");
    await B.api.json("DELETE", `/v1/channels/${Z.id}`);
    const c = await channels(B);
    expect(c).toMatchObject({ using: "pool", own: [], removed: [{ id: Z.id, how: "removed", unavailableFiles: 0 }] });
  });
});

describe("channels: move and remove", () => {
  it("non-critical then critical: every file readable through the OLD manifests (alias), a share link from before still opens, old messages deleted, chain rewritten and rebuildable, webhook listed as moved", async () => {
    const I = await instance();
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000831", "X");
    const Y = await ownChannel(I, A, "1550000000000000832", "Y");
    const files = [bytes(64 * 1024 * 5 + 17, 11), bytes(3000, 12), bytes(64 * 1024 * 2, 13)];
    const ups = [];
    for (const [i, d] of files.entries()) ups.push(await A.client.upload(memorySource(d), `m${i}.bin`));
    I.clock.t += 120_000;
    await I.m.snapshots.tick(true);
    const ptr0 = I.m.snapshots.location(A.accountId)!;
    expect(ptr0.webhookId).toBe(X.id);
    const oldObjs = I.srv.db.prepare("SELECT message_id FROM s_snap_objs WHERE account_id = ?").all(A.accountId) as { message_id: string }[];
    // A share link made before the move (it holds the old attachment IDs).
    const n0 = A.client.store.getNode(ups[0]!.nodeId)!;
    const prep = await prepareShareWith({ loadManifest: (ref) => A.client.loadManifest(ref), attachments: async (loc, manifest) => {
      const ids = [loc.at.attachmentId, ...[...manifest.chunks].sort((a, b) => a.index - b.index).map((c) => (c.placements![0] as { attachmentId: string }).attachmentId)];
      return (await A.api.json<{ attachments: { channelId: string; attachmentId: string; filename: string }[] }>("POST", "/v1/blobs/describe", { attachmentIds: ids })).body.attachments;
    } }, n0.content!.manifestRef, { name: "m0.bin", size: files[0]!.byteLength, mime: "application/octet-stream", sha256: n0.content!.plaintextSha256 } as never);
    const share = await A.api.json<{ shareId: string }>("POST", "/v1/shares", { attachments: prep.attachments, meta: prep.meta, ownerNote: "AAAA" });
    const shareKey = Buffer.from(prep.fileKey.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("base64");
    const shareSha = async () => {
      const s = sink();
      await (await openShare(I.url, share.body.shareId, shareKey)).download(s);
      return sha256Hex(s.data());
    };
    // Opened once before the move: the instance caches the refreshed links of the old attachments.
    expect(await shareSha()).toBe(await sha256Hex(files[0]!));

    // 1. Move Y (not critical) to X.
    const onY = blobsOn(I, Y.id);
    expect(onY).toBeGreaterThan(0);
    const postsBefore = I.fake.posts;
    const st = await A.api.json<{ move: { state: string; total: number } }>("POST", `/v1/channels/${Y.id}/move`, {});
    expect(st.status).toBe(202);
    await I.m.blobs.moves();
    const c1 = await channels(A);
    expect(c1.move).toMatchObject({ state: "done", done: onY, total: onY });
    expect(I.fake.posts - postsBefore).toBe(onY); // one copy per blob, nothing else
    expect(blobsOn(I, Y.id)).toBe(0);
    expect(msgsOn(I, Y.id)).toBe(0); // old messages deleted from Discord
    expect(c1.own.map((r) => r.id)).toEqual([X.id]);
    expect(c1.removed).toEqual([expect.objectContaining({ id: Y.id, how: "moved", unavailableFiles: 0 })]);
    // The client still has the OLD placements in its manifests; the server answers for them.
    for (const [i, u] of ups.entries()) expect(await sameBytes(A, u.nodeId, files[i]!)).toBe(true);
    const aliased = I.srv.db.prepare("SELECT attachment_id FROM s_blob_alias").all() as { attachment_id: string }[];
    expect(aliased.length).toBe(onY);
    const via = await A.api.request("GET", `/v1/blobs/${aliased[0]!.attachment_id}`); // proxy path by the old ID
    expect(via.status).toBe(200);
    const urls = await A.api.json<{ urls: { attachmentId: string; url: string }[] }>("POST", "/v1/blobs/urls", { attachments: [{ attachmentId: aliased[0]!.attachment_id }] });
    expect(urls.body.urls[0]!.attachmentId).toBe(aliased[0]!.attachment_id); // keyed by what was asked
    // Another account cannot use an alias either.
    const C = await account(I);
    expect((await C.api.request("GET", `/v1/blobs/${aliased[0]!.attachment_id}`)).status).toBe(404);

    // 2. Move X (critical: pointer + segments): no other own channel left, so the pool takes it.
    const head = I.srv.logHead(A.accountId);
    expect((await A.api.json<{ otherActive: number }>("GET", `/v1/channels/${X.id}/impact`)).body.otherActive).toBe(2);
    await A.api.json("POST", `/v1/channels/${X.id}/move`, {});
    await I.m.blobs.moves();
    const c2 = await channels(A);
    expect(c2.move).toMatchObject({ state: "done" });
    expect(c2).toMatchObject({ using: "pool", own: [] });
    expect(msgsOn(I, X.id)).toBe(0); // blobs, old pointer and old segments: all gone from X
    const ptr1 = I.m.snapshots.location(A.accountId)!;
    expect(I.pool.map((h) => h.id)).toContain(ptr1.webhookId);
    expect(ptr1.messageId).not.toBe(ptr0.messageId);
    for (const o of oldObjs) expect(I.fake.messages.has(o.message_id)).toBe(false);
    expect(readFileSync(join(I.dir, "snapshots.json"), "utf8")).toContain(ptr1.messageId);
    // The new chain is the whole log.
    const log = await rebuildAccountLog(I.m.instanceKey, I.m.hooks(), I.m.sender, A.accountId, ptr1);
    expect(log.map((e) => e.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    for (const [i, u] of ups.entries()) expect(await sameBytes(A, u.nodeId, files[i]!)).toBe(true);
    // The share link from before both moves still downloads (aliases through the instance refresher;
    // the share link cache of the old attachments was dropped when the moves finished).
    expect(await shareSha()).toBe(await sha256Hex(files[0]!));
    // New segments land on the new pointer's webhook.
    await A.client.commitOp({ type: "create", kind: "folder", nodeId: "folderDDDDDDDDDDDDDDDDD", parentId: "root", name: "after" }, "mkdir");
    I.clock.t += 120_000;
    await I.m.snapshots.tick(true);
    expect((I.srv.db.prepare("SELECT DISTINCT webhook_id FROM s_snap_objs WHERE account_id = ?").all(A.accountId) as { webhook_id: string }[]).map((r) => r.webhook_id)).toEqual([ptr1.webhookId]);
    expect((await rebuildAccountLog(I.m.instanceKey, I.m.hooks(), I.m.sender, A.accountId, ptr1)).length).toBe(head + 1);
  });

  it("resumes after an interruption without posting finished blobs again", async () => {
    const I = await instance();
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000841", "X");
    const Y = await ownChannel(I, A, "1550000000000000842", "Y");
    const data = bytes(64 * 1024 * 12, 21);
    const up = await A.client.upload(memorySource(data), "big.bin");
    const onY = blobsOn(I, Y.id);
    expect(onY).toBeGreaterThanOrEqual(4);
    // Discord fails after 2 copies (e.g. the instance lost its network).
    const real = I.m.sender.post.bind(I.m.sender);
    let n = 0;
    I.m.sender.post = (async (...a: Parameters<typeof real>) => {
      if (++n > 2) throw new Error("network down");
      return real(...a);
    }) as typeof real;
    const posts0 = I.fake.posts;
    await A.api.json("POST", `/v1/channels/${Y.id}/move`, {});
    await I.m.blobs.moves();
    let mv: { state: string; done: number; error?: string; etaMs?: number | null } = (await A.api.json<{ move: { state: string; done: number; error?: string; etaMs: number | null } }>("GET", "/v1/channels/move")).body.move;
    expect(mv).toMatchObject({ state: "paused", done: 2, error: "network down" });
    expect(mv.etaMs).toBeGreaterThan(0);
    expect(blobsOn(I, Y.id)).toBe(onY - 2);
    expect((await channels(A)).own.find((r) => r.id === Y.id)!.retired).toBe(true); // still here, retired
    expect(msgsOn(I, Y.id)).toBe(onY); // nothing deleted before the move is complete
    // Not before the retry time.
    I.m.sender.post = real;
    await I.m.blobs.moves();
    expect((await A.api.json<{ move: { state: string } }>("GET", "/v1/channels/move")).body.move.state).toBe("paused");
    // A new server process (restart) picks the job up from the database.
    I.clock.t += MOVE_RETRY_MS + 1;
    const fresh = new ChannelStore(I.srv.db, I.m.hooks(), () => I.clock.t);
    expect(fresh.dueJobs().length).toBe(1);
    await I.m.blobs.moves();
    mv = (await A.api.json<{ move: { state: string; done: number } }>("GET", "/v1/channels/move")).body.move;
    expect(mv).toMatchObject({ state: "done", done: onY });
    expect(I.fake.posts - posts0).toBe(onY); // 2 before the failure + the rest after: no blob posted twice
    expect(msgsOn(I, Y.id)).toBe(0);
    expect(await sameBytes(A, up.nodeId, data)).toBe(true);
    void X;
  });
});

describe("channels: remove anyway, unavailable, recovery", () => {
  it("unavailable is computed: listed after a removal, back at once when the same webhook is pasted again; the bot recovers and moves them", async () => {
    const I = await instance({ bot: true });
    const A = await account(I);
    const X = await ownChannel(I, A, "1550000000000000851", "X");
    const Y = await ownChannel(I, A, "1550000000000000852", "Y");
    const files = [bytes(64 * 1024 * 3, 31), bytes(64 * 1024 * 3, 32)];
    const ups = [];
    for (const [i, d] of files.entries()) ups.push(await A.client.upload(memorySource(d), `u${i}.bin`));
    const hit = new Set((I.srv.db.prepare("SELECT DISTINCT upload_id FROM s_blobs WHERE webhook_id = ?").all(Y.id) as { upload_id: string }[]).map((r) => r.upload_id));
    expect(hit.size).toBeGreaterThan(0);
    const imp = (await A.api.json<{ files: number; uploads: string[] }>("GET", `/v1/channels/${Y.id}/impact`)).body;
    expect(new Set(imp.uploads)).toEqual(hit);
    expect(imp.files).toBe(hit.size);
    await A.api.json("DELETE", `/v1/channels/${Y.id}`);
    const un = (await A.api.json<{ uploads: { uploadId: string; webhookIds: string[] }[] }>("GET", "/v1/channels/unavailable")).body.uploads;
    expect(new Set(un.map((u) => u.uploadId))).toEqual(hit);
    expect(un.every((u) => u.webhookIds.length === 1 && u.webhookIds[0] === Y.id)).toBe(true);
    const c = await channels(A);
    expect(c.removed).toEqual([expect.objectContaining({ id: Y.id, how: "removed", unavailableFiles: hit.size })]);
    expect(c.botRecovery).toBe(true);
    expect(msgsOn(I, Y.id)).toBeGreaterThan(0); // nothing deleted
    await expect(A.client.download(ups.find((u) => hit.has(u.uploadId))!.nodeId, sink())).rejects.toThrow();
    // Pasted again: available again, no log entry needed.
    const head = I.srv.logHead(A.accountId);
    await A.api.json("POST", "/v1/channels", { url: Y.url });
    expect((await A.api.json<{ uploads: unknown[] }>("GET", "/v1/channels/unavailable")).body.uploads).toEqual([]);
    expect((await channels(A)).removed).toEqual([]);
    expect(I.srv.logHead(A.accountId)).toBe(head);
    for (const [i, u] of ups.entries()) expect(await sameBytes(A, u.nodeId, files[i]!)).toBe(true);
    // Removed again, then recovered with the bot: read via refresh-urls, moved to X.
    await A.api.json("DELETE", `/v1/channels/${Y.id}`);
    const onY = blobsOn(I, Y.id);
    I.clock.t += 13 * 3600_000; // past the server's link cache: only the bot can read Y now
    const st = await A.api.json<{ move: { state: string } }>("POST", `/v1/channels/${Y.id}/recover`, {});
    expect(st.status).toBe(202);
    await I.m.blobs.moves();
    expect((await channels(A)).move).toMatchObject({ state: "done", done: onY, total: onY });
    expect(blobsOn(I, Y.id)).toBe(0);
    expect((await A.api.json<{ uploads: unknown[] }>("GET", "/v1/channels/unavailable")).body.uploads).toEqual([]);
    expect((await channels(A)).removed).toEqual([expect.objectContaining({ id: Y.id, how: "moved", unavailableFiles: 0 })]);
    expect(I.fake.refreshCalls).toBeGreaterThan(0);
    for (const [i, u] of ups.entries()) expect(await sameBytes(A, u.nodeId, files[i]!)).toBe(true);
  });

  it("recover needs a bot", async () => {
    const I = await instance();
    const A = await account(I);
    await ownChannel(I, A, "1550000000000000861", "X");
    const Y = await ownChannel(I, A, "1550000000000000862", "Y");
    await A.client.upload(memorySource(bytes(64 * 1024 * 3, 41)), "a");
    await A.api.json("DELETE", `/v1/channels/${Y.id}`);
    await expect(A.api.json("POST", `/v1/channels/${Y.id}/recover`, {})).rejects.toMatchObject({ status: 409, code: "no_bot" });
    expect((await channels(A)).botRecovery).toBe(false);
  });
});

describe("channels: pool scope and plain", () => {
  it("plain: thumbnails/streaming read through the moved blobs; pool webhook moved by the operator store (all accounts)", async () => {
    const I = await instance({ plain: true, pool: 3 });
    const A = await account(I, true);
    const B = await account(I, true);
    const da = new Uint8Array(64 * 1024 * 4 + 99).map((_, i) => (i * 13) & 255);
    const ua = await A.client.upload(memorySource(da), "film.webm");
    const db = bytes(64 * 1024 * 3, 51);
    const ub = await B.client.upload(memorySource(db), "b.bin");
    I.plain!.replica(A.accountId);
    await I.plain!.idle;
    const W = I.pool.map((h) => h.id).sort((a, b) => blobsOn(I, b) - blobsOn(I, a))[0]!;
    expect(blobsOn(I, W)).toBeGreaterThan(0);
    const cs = I.store();
    const rows = cs.rows(POOL);
    expect(rows.reduce((a, r) => a + r.files, 0)).toBeGreaterThanOrEqual(2);
    expect(cs.impact(POOL, W).otherActive).toBe(2);
    cs.enqueueMove(POOL, W);
    await I.m.blobs.moves();
    expect(cs.status(cs.lastJob(POOL))).toMatchObject({ state: "done" });
    expect(I.m.hooks().list(POOL).map((h) => h.id)).not.toContain(W);
    expect(msgsOn(I, W)).toBe(0);
    // plain server reads (Range streaming) with the old manifest placements
    const r = await A.api.request("GET", `/v1/plain/file/${ua.nodeId}`, { headers: { range: "bytes=70000-70099" } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(da.subarray(70000, 70100)))).toBe(true);
    const whole = await A.api.request("GET", `/v1/plain/file/${ua.nodeId}`);
    expect(await sha256Hex(new Uint8Array(await whole.arrayBuffer()))).toBe(await sha256Hex(da));
    expect(await sameBytes(B, ub.nodeId, db)).toBe(true);
  });
});
