// Trash + fragment cleanup in metadata only (zlecenie 2026-10-13 p. 2, koncept §6.2, Q4):
// purge + retention -> the fragments disappear from (fake) Discord, those a kept base snapshot
// still points at stay, a restore from that snapshot still downloads; the Q4 gates (main device,
// metered link, 7 days) and the server bookkeeping (another device does not delete twice).
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS, ROOT_ID, canonicalState } from "@ddv4/sync-core";
import {
  ChannelPacer,
  Cleaner,
  DriveClient,
  EncryptedArbiter,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  clientBlobIO,
  createPointerMessage,
  memorySource,
  readPointer,
  restoreFromDiscord,
  type ByteSink,
  type PointerLocation,
} from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);

const HOOK = { id: "555555555555555555", url: "mem://hook/5" };
const sink = (): ByteSink & { bytes: () => number } => {
  let n = 0;
  return { write: async (d) => void (n += d.byteLength), bytes: () => n };
};

async function setup() {
  let now = Date.UTC(2026, 9, 1, 8);
  const { url } = await startServer({ now: () => now, rateLimits: false });
  const acct = await newAccount(url);
  const transport = new MemoryTransport();
  const mk = (deviceId: string, api: typeof acct.api) =>
    new MetadataClient({ device: { id: deviceId, name: deviceId }, arbiter: new EncryptedArbiter(new OpCodec(acct.key, acct.accountId), api), transport, webhooks: [HOOK], chunkSize: 1000, now: () => now, pacer: new ChannelPacer({ perMin: 60_000, maxPerMin: 60_000, burst: 1000 }) });
  const a = mk(acct.deviceId, acct.api);
  const io = clientBlobIO(a, transport);
  const loc: PointerLocation = await createPointerMessage(io, acct.key, acct.accountId, a.webhook(HOOK.id));
  const sched = new SnapshotScheduler({
    io, key: acct.key, accountId: acct.accountId, pointer: loc, log: acct.api, store: a.store, now: () => now,
    isPrimary: () => true, unmetered: () => true, serverTimeOf: () => now - 2 * 60_000,
  });
  const cleaner = (c: DriveClient, api: typeof acct.api, o: { primary?: boolean; metered?: boolean } = {}) =>
    new Cleaner({
      client: c,
      log: new EncryptedArbiter(new OpCodec(acct.key, acct.accountId), api),
      api: api.gc(),
      transport,
      webhook: (id) => (c as MetadataClient).webhook(id),
      pointer: () => readPointer(io, acct.key, acct.accountId, loc),
      isPrimary: () => o.primary ?? true,
      metered: () => o.metered ?? false,
      sleep: async () => {},
    });
  return { url, acct, transport, a, io, loc, sched, cleaner, mk, clock: { get: () => now, add: (ms: number) => void (now += ms) } };
}

describe("cleanup in metadata only", () => {
  it("purge + retention: fragments go from Discord, those a kept base points at stay, restore from that base still downloads", async () => {
    const S = await setup();
    const { a, transport, clock } = S;
    const old = await a.upload(memorySource(crypto.getRandomValues(new Uint8Array(3500))), "stary.bin"); // 4 fragments + manifest
    const keep = await a.upload(memorySource(crypto.getRandomValues(new Uint8Array(2500))), "zostaje.bin");
    // A base that knows both files (the restore point the test checks later).
    clock.add(60_000);
    expect((await S.sched.tick(true))?.kind).toBe("base");
    const baseSeq = a.store.getMeta().headSeq;
    const fileMsgs = (r: { version: { manifestRef: string } }) => a.loadManifest(r.version.manifestRef).then(({ manifest }) => manifest.chunks.map((c) => c.placements![0]!.messageId!));
    const oldMsgs = await fileMsgs(old);
    expect(oldMsgs.every((m) => transport.messages.has(m))).toBe(true);

    // Trash, then the Q4 trash step after 31 days (it purges), the fragments wait for retention.
    await a.commitOp({ type: "trash", nodeId: old.nodeId }, "trash");
    clock.add(31 * DAY_MS);
    const c1 = S.cleaner(a, S.acct.api);
    const r1 = await c1.run();
    expect(r1).toMatchObject({ purged: 1, uploads: 0 });
    expect(a.store.getNode(old.nodeId)).toBeUndefined();
    expect(a.store.getUpload(old.uploadId)?.status).toBe("released");
    // 31 more days: retention passed, but the only base (taken before the purge) still points at the file.
    clock.add(31 * DAY_MS);
    const pv = await c1.preview();
    expect(pv).toMatchObject({ deletable: 0, waiting: 1 });
    expect((await c1.run(true)).uploads).toBe(0);
    expect(oldMsgs.every((m) => transport.messages.has(m))).toBe(true);
    // Restore from the held base: the purged file is back in that tree and downloads in full.
    const pit = await restoreFromDiscord(S.io, S.acct.key, S.acct.accountId, S.loc, undefined, baseSeq);
    expect(pit.store.getNode(old.nodeId)?.name).toBe("stary.bin");
    const restored = new MetadataClient({ device: { id: "restore", name: "r" }, arbiter: new EncryptedArbiter(new OpCodec(S.acct.key, S.acct.accountId), S.acct.api), transport, webhooks: [HOOK], store: pit.store });
    const s = sink();
    await restored.download(old.nodeId, s);
    expect(s.bytes()).toBe(3500);

    // Newer bases over the next week push the old one out of retention (7 daily + 4 weekly kept):
    // simulate it by advancing the pointer history the way pruneSnapshots does (one base per day).
    for (let d = 0; d < 40; d++) {
      clock.add(DAY_MS);
      await a.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(d).padStart(6, "0")}xx`, parentId: ROOT_ID, name: `d${d}` }, "mk");
      await S.sched.tick(true);
    }
    const p = await readPointer(S.io, S.acct.key, S.acct.accountId, S.loc);
    expect(Math.min(...[p.base!, ...(p.history ?? [])].map((b) => b.headSeq))).toBeGreaterThan(a.store.getUpload(old.uploadId)!.ended!.seq);
    const pv2 = await c1.preview();
    expect(pv2).toMatchObject({ deletable: 1 });
    expect(pv2.deletableBytes).toBe(3500);
    const r2 = await c1.run(true);
    expect(r2).toMatchObject({ uploads: 1, messages: 5, left: 0 });
    expect(oldMsgs.some((m) => transport.messages.has(m))).toBe(false);
    // The other file is untouched and still downloads.
    const k = sink();
    await a.download(keep.nodeId, k);
    expect(k.bytes()).toBe(2500);
    // Bookkeeping: a second device does not delete again, and the server knows the last run.
    const devB = await addDevice(S.url, S.acct);
    const b = S.mk(devB.deviceId, devB.api);
    await b.pull();
    expect(canonicalState(b.store)).toBe(canonicalState(a.store));
    const st = await devB.api.gc().status();
    expect(st.doneCount).toBe(1);
    expect(st.lastRunAt).toBe(S.clock.get());
    const r3 = await S.cleaner(b, devB.api).run(true);
    expect(r3).toMatchObject({ uploads: 0, messages: 0 });
  });

  it("Q4 gates: not the main device -> only after 7 days without cleanup; metered -> never automatically; manual overrides both", async () => {
    const S = await setup();
    const { a, clock } = S;
    const f = await a.upload(memorySource(new Uint8Array(500)), "x.bin");
    await a.commitOp({ type: "trash", nodeId: f.nodeId }, "trash");
    clock.add(31 * DAY_MS);
    // Metered main device: no automatic run.
    expect((await S.cleaner(a, S.acct.api, { metered: true }).run()).trashSkipped).toBe("metered");
    // Secondary device right after another device's run: the main device cleans, not this one.
    await S.acct.api.gc().record({ uploads: [], run: true });
    expect((await S.cleaner(a, S.acct.api, { primary: false }).run()).trashSkipped).toBe("primary_cleans");
    // 7 days later nobody has cleaned: any device may.
    clock.add(7 * DAY_MS + 1);
    expect((await S.cleaner(a, S.acct.api, { primary: false }).run()).purged).toBe(1);
  });

  it("a manual run on a metered secondary device works (the user asked); nothing expired = nothing purged", async () => {
    const S = await setup();
    const { a, clock } = S;
    const f = await a.upload(memorySource(new Uint8Array(500)), "y.bin");
    await a.commitOp({ type: "trash", nodeId: f.nodeId }, "trash");
    clock.add(10 * DAY_MS);
    const r0 = await S.cleaner(a, S.acct.api, { primary: false, metered: true }).run(true);
    expect(r0).toMatchObject({ purged: 0, trashSkipped: "nothing_expired" });
    clock.add(21 * DAY_MS);
    expect((await S.cleaner(a, S.acct.api, { primary: false, metered: true }).run(true)).purged).toBe(1);
  });
});
