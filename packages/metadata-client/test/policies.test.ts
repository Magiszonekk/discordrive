import { describe, expect, it } from "vitest";
import { DAY_MS, MemoryIndexStore, ROOT_ID, RULES_VERSION, Sequencer, applyEntry, initIndex, type LogEntry, type Operation } from "@ddv4/sync-core";
import { LogObserver, decideTrashCleanup, trashCleanupOp, ANY_DEVICE_CLEANS_AFTER_MS } from "../src/index.js";

const T0 = Date.UTC(2026, 9, 1);

function harness() {
  let now = T0;
  const seq = new Sequencer({ now: () => now });
  const store = initIndex(new MemoryIndexStore());
  const obs = new LogObserver();
  let n = 0;
  const alerts: unknown[] = [];
  const run = (op: Operation, dev = "dev-A", extra: Partial<LogEntry> = {}) => {
    const r = seq.submit({ opId: `op-${String(++n).padStart(8, "0")}`, rulesVersion: RULES_VERSION, baseSeq: store.getMeta().headSeq, device: { id: dev, name: dev }, createdAt: now, op, ...extra });
    if (r.status !== "accepted") throw new Error(r.status);
    const res = applyEntry(store, r.entry);
    const a = obs.observe(r.entry, res);
    if (a) alerts.push(a);
    return res;
  };
  return { store, obs, run, alerts, setNow: (t: number) => void (now = t), now: () => now };
}

describe("client policies (DECISIONS Q4, Q5, Q10)", () => {
  it("Q4: primary cleans expired trash; others only after 7 days without a purge; never unsynced or metered", () => {
    const h = harness();
    h.run({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "a" });
    h.run({ type: "create", kind: "folder", nodeId: "fold-00002", parentId: ROOT_ID, name: "b" });
    h.run({ type: "trash", nodeId: "fold-00001" });
    h.setNow(T0 + 10 * DAY_MS);
    h.run({ type: "trash", nodeId: "fold-00002" });
    const ctx = (over = {}) => ({ isPrimary: true, fullySynced: true, metered: false, now: h.now(), lastPurgeAt: h.obs.lastPurgeAt, logStartedAt: h.obs.logStartedAt, ...over });

    h.setNow(T0 + 29 * DAY_MS);
    expect(decideTrashCleanup(h.store, ctx())).toEqual({ clean: false, reason: "nothing_expired" });
    h.setNow(T0 + 31 * DAY_MS);
    expect(decideTrashCleanup(h.store, ctx())).toEqual({ clean: true, nodeIds: ["fold-00001"] });
    expect(decideTrashCleanup(h.store, ctx({ fullySynced: false }))).toMatchObject({ clean: false, reason: "not_synced" });
    expect(decideTrashCleanup(h.store, ctx({ metered: true }))).toMatchObject({ clean: false, reason: "metered" });
    // secondary: nobody purged since the log started 31 days ago -> may clean
    expect(decideTrashCleanup(h.store, ctx({ isPrimary: false }))).toMatchObject({ clean: true });

    const d = decideTrashCleanup(h.store, ctx());
    if (!d.clean) throw new Error("expected clean");
    expect(h.run(trashCleanupOp(d.nodeIds), "dev-primary").outcome).toBe("applied");
    expect(h.store.getNode("fold-00001")).toBeUndefined();
    expect(h.obs.lastPurgeAt).toBe(T0 + 31 * DAY_MS);

    // fold-00002 expires at day 40. A secondary device waits until 7 days after the last purge.
    h.setNow(T0 + 41 * DAY_MS);
    expect(decideTrashCleanup(h.store, ctx({ isPrimary: false, lastPurgeAt: T0 + 36 * DAY_MS }))).toMatchObject({ clean: false, reason: "primary_cleans" });
    expect(decideTrashCleanup(h.store, ctx({ isPrimary: false, lastPurgeAt: T0 + 41 * DAY_MS - ANY_DEVICE_CLEANS_AFTER_MS }))).toEqual({ clean: true, nodeIds: ["fold-00002"] });
    expect(decideTrashCleanup(h.store, ctx({ isPrimary: false }))).toEqual({ clean: true, nodeIds: ["fold-00002"] }); // last purge day 31
  });

  it("Q4: a cleanup group skips a node restored meanwhile and purges the rest (Q9)", () => {
    const h = harness();
    for (const id of ["fold-00001", "fold-00002"]) {
      h.run({ type: "create", kind: "folder", nodeId: id, parentId: ROOT_ID, name: id });
      h.run({ type: "trash", nodeId: id });
    }
    h.setNow(T0 + 31 * DAY_MS);
    const d = decideTrashCleanup(h.store, { isPrimary: true, fullySynced: true, metered: false, now: h.now(), lastPurgeAt: null, logStartedAt: T0 });
    if (!d.clean) throw new Error("expected clean");
    h.run({ type: "restore", nodeId: "fold-00002" }, "dev-B");
    const r = h.run(trashCleanupOp(d.nodeIds), "dev-A");
    expect(r.outcome).toBe("applied");
    expect(h.store.getNode("fold-00001")).toBeUndefined();
    expect(h.store.getNode("fold-00002")?.trashed).toBeNull();
  });

  it("Q10: invalid ops are counted per device and alert once after 5", () => {
    const h = harness();
    for (let i = 0; i < 7; i++) h.run({ type: "rename", nodeId: "root", name: `x${i}` }, "dev-bad");
    h.run({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "ok" }, "dev-good");
    expect(h.obs.invalidCount("dev-bad")).toBe(7);
    expect(h.obs.invalidCount("dev-good")).toBe(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ deviceId: "dev-bad", count: 5 });
    expect(LogObserver.message(h.alerts[0] as never)).toMatch(/5 invalid operations/);
  });

  it("Q5: a non-NFC name from another device is applied as is and only flagged", () => {
    const h = harness();
    const nfd = "Zaz\u0307o\u0301\u0142c\u0301";
    expect(h.run({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: nfd }, "dev-mac").outcome).toBe("applied");
    expect(h.store.getNode("fold-00001")!.name).toBe(nfd);
    expect(h.obs.nonNfcNames).toEqual([{ seq: 1, nodeId: "fold-00001", deviceId: "dev-mac" }]);
  });
});

describe("MetadataClient wires the log observer", () => {
  it("reports a misbehaving device once (Q10) and tracks purges (Q4)", async () => {
    const { LocalArbiter, MemoryTransport, MetadataClient } = await import("../src/index.js");
    const seq = new Sequencer();
    const alerts: string[] = [];
    const c = new MetadataClient({ device: { id: "dev-me", name: "me" }, arbiter: new LocalArbiter(seq), transport: new MemoryTransport(), webhooks: [{ id: "1", url: "mem://" }], onInvalidOps: (a) => alerts.push(a.deviceId) });
    for (let i = 0; i < 6; i++) seq.submit({ opId: `op-bad${String(i).padStart(5, "0")}`, rulesVersion: RULES_VERSION, baseSeq: 0, device: { id: "dev-old", name: "old" }, createdAt: 0, op: { type: "trash", nodeId: "root" } });
    await c.pull();
    expect(alerts).toEqual(["dev-old"]);
    await c.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "x" }, "mk");
    await c.commitOp({ type: "trash", nodeId: "fold-00001" }, "tr");
    await c.commitOp({ type: "purge", nodeId: "fold-00001" }, "pg");
    expect(c.observer.lastPurgeAt).not.toBeNull();
  });
});
