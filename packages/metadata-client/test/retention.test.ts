import { describe, expect, it } from "vitest";
import { canonicalState, ROOT_ID, replay, type LogEntry } from "@ddv4/sync-core";
import {
  EncryptedArbiter,
  InProcessLogServer,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  clientBlobIO,
  createPointerMessage,
  newAccountKey,
  readPointer,
  restoreFromDiscord,
  selectRetained,
  type BaseRef,
} from "../src/index.js";

const DAY = 24 * 3600_000;
const ACCT = "acct-ret";
const HOOK = { id: "888888888888888888", url: "mem://hook/8" };

describe("snapshot retention (7 daily + 4 weekly bases)", () => {
  it("selectRetained keeps the current base, one per day for 7 days, one per week for 4 weeks", () => {
    const t0 = Date.UTC(2026, 6, 6); // a Monday
    const bases: BaseRef[] = [];
    // 60 days, 3 bases a day
    for (let d = 0; d < 60; d++) for (let k = 0; k < 3; k++) bases.push({ headSeq: d * 10 + k + 1, parts: [], size: 1, createdAt: t0 + d * DAY + k * 3600_000 });
    const { keep, drop } = selectRetained(bases);
    expect(keep.length + drop.length).toBe(180);
    expect(keep[0]!.headSeq).toBe(593); // newest
    const days = new Set(keep.map((b) => Math.floor(b.createdAt / DAY)));
    // 7 most recent days + up to 4 weeks (some overlap with the days)
    for (let d = 53; d < 60; d++) expect(days.has(Math.floor((t0 + d * DAY) / DAY))).toBe(true);
    expect(keep.length).toBe(7 + 4); // current base is also the newest daily
    const oldest = keep.at(-1)!;
    const back = (t0 + 60 * DAY - oldest.createdAt) / DAY;
    expect(back).toBeGreaterThan(28); // ~30 days back
    expect(back).toBeLessThan(36);
  });

  it("scheduler over 45 simulated days: bases pruned to 7+4, old segments deleted, any kept point restorable", async () => {
    let now = Date.UTC(2026, 8, 1, 8);
    const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
    const key = newAccountKey();
    const transport = new MemoryTransport();
    const server = new InProcessLogServer({ now: clock.now });
    const session = server.session("dev-A");
    const c = new MetadataClient({ device: { id: "dev-A", name: "A" }, arbiter: new EncryptedArbiter(new OpCodec(key, ACCT), session), transport, webhooks: [HOOK], ...clock });
    const io = clientBlobIO(c, transport, 4096);
    const loc = await createPointerMessage(io, key, ACCT, c.webhook(HOOK.id));
    const sched = new SnapshotScheduler({
      io, key, accountId: ACCT, pointer: loc, log: session, store: c.store, now: clock.now,
      isPrimary: () => true, unmetered: () => true,
      serverTimeOf: (seq) => server.log.read(seq - 1, 1)[0]?.serverTime,
    });
    const statesAt = new Map<number, string>();
    let n = 0;
    for (let day = 0; day < 45; day++) {
      for (let k = 0; k < 4; k++) {
        await c.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(++n).padStart(6, "0")}`, parentId: ROOT_ID, name: `f${n}` }, "mk");
        now += 2 * 60_000;
        await sched.tick();
        statesAt.set(c.store.getMeta().headSeq, canonicalState(c.store));
      }
      // force a base every day (as if the 20 % rule had fired)
      await sched.tick(true);
      now += DAY - 8 * 60_000;
    }
    const p = await readPointer(io, key, ACCT, loc);
    const bases = [p.base!, ...(p.history ?? [])];
    expect(bases.length).toBeLessThanOrEqual(12);
    expect(bases.length).toBeGreaterThanOrEqual(8);
    expect(p.prunedUpTo).toBeGreaterThan(0);
    // Discord holds exactly: pointer + parts of kept bases + segments after prunedUpTo.
    const live = transport.messages.size;
    const posts = transport.posts;
    const segIds = new Set(sched.history.map((r) => r.pointer.lastSegment).filter((x) => x && x.toSeq > p.prunedUpTo!).map((x) => x!.messageId));
    const partIds = new Set(bases.flatMap((b) => b.parts.map((x) => x.messageId)));
    expect(live).toBe(1 + partIds.size + segIds.size);
    expect([...segIds, ...partIds, loc.messageId].every((id) => transport.messages.has(id))).toBe(true);
    const oldest = Math.min(...bases.map((b) => b.createdAt));
    expect((now - oldest) / DAY).toBeGreaterThan(28);

    // Restore the newest state and a point between two kept bases, check both against what the device had.
    const latest = await restoreFromDiscord(io, key, ACCT, loc);
    expect(canonicalState(latest.store)).toBe(canonicalState(c.store));
    const sortedBases = bases.map((b) => b.headSeq).sort((a, b) => a - b);
    const mid = sortedBases[1]! + 2;
    const pit = await restoreFromDiscord(io, key, ACCT, loc, undefined, mid);
    const full = replay((await Promise.all(server.log.read(0).slice(0, mid).map((e) => new OpCodec(key, ACCT).decrypt(e)))) as LogEntry[]);
    expect(canonicalState(pit.store)).toBe(canonicalState(full.store));
    // Older than retention: refused instead of a wrong tree.
    await expect(restoreFromDiscord(io, key, ACCT, loc, undefined, 3)).rejects.toThrow(/older than the retained/);
    console.log(JSON.stringify({ days: 45, entries: c.store.getMeta().headSeq, basesKept: bases.length, prunedUpTo: p.prunedUpTo, discordPosts: posts, discordLive: live }));
  });

  it("only the primary device writes; a phone writes segments but never bases", async () => {
    let now = Date.UTC(2026, 8, 1, 8);
    const key = newAccountKey();
    const transport = new MemoryTransport();
    const server = new InProcessLogServer({ now: () => now });
    const session = server.session("dev-P");
    const c = new MetadataClient({ device: { id: "dev-P", name: "phone" }, arbiter: new EncryptedArbiter(new OpCodec(key, ACCT), session), transport, webhooks: [HOOK], now: () => now });
    const io = clientBlobIO(c, transport);
    const loc = await createPointerMessage(io, key, ACCT, c.webhook(HOOK.id));
    let primary = false;
    const sched = new SnapshotScheduler({ io, key, accountId: ACCT, pointer: loc, log: session, store: c.store, now: () => now, isPrimary: () => primary, unmetered: () => false, serverTimeOf: () => now - 2 * 60_000 });
    await c.commitOp({ type: "create", kind: "folder", nodeId: "fold-000001", parentId: ROOT_ID, name: "x" }, "mk");
    expect(await sched.tick()).toBeNull();
    primary = true;
    const r = await sched.tick();
    expect(r?.kind).toBe("segment");
    expect((await readPointer(io, key, ACCT, loc)).base).toBeNull();
  });
});

describe("fragment deletion respects kept bases", () => {
  it("a released upload is deletable only after 30 days and once every kept base is newer than the release", async () => {
    const { deletableUploadsWithRetention, emptyPointer } = await import("../src/index.js");
    const { MemoryIndexStore, initIndex } = await import("@ddv4/sync-core");
    const store = initIndex(new MemoryIndexStore());
    store.putUpload({ id: "upl-released1", status: "released", began: { seq: 1, deviceId: "d" }, boundTo: null, ended: { seq: 50, at: 0, reason: "purged", opId: "op-x0000001" } });
    store.putUpload({ id: "upl-aborted01", status: "aborted", began: { seq: 2, deviceId: "d" }, boundTo: null, ended: { seq: 3, at: 0, reason: "aborted", opId: "op-x0000002" } });
    const base = (headSeq: number): BaseRef => ({ headSeq, parts: [], size: 1, createdAt: 0 });
    const p = { ...emptyPointer(), base: base(100), history: [base(40)] };
    expect(deletableUploadsWithRetention(store, p, 10 * DAY)).toEqual(["upl-aborted01"]);
    expect(deletableUploadsWithRetention(store, p, 31 * DAY)).toEqual(["upl-aborted01"]); // base at 40 still points at it
    expect(deletableUploadsWithRetention(store, { ...p, history: [base(60)] }, 31 * DAY)).toEqual(["upl-aborted01", "upl-released1"]);
  });
});
