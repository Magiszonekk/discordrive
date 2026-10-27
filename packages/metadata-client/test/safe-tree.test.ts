// The Safe's tree: the sync core's rules inside the sealed state (folders, names, trash, Drive and Gallery),
// concurrent edits from two devices resolved by the same rules as the account, nothing in the account's log.
import { afterEach, describe, expect, it } from "vitest";
import { GALLERY_ID, RECOVERED_ID, RULES_VERSION, MemoryIndexStore, applyEntry, checkInvariants, initIndex, takeSnapshot } from "@ddv4/sync-core";
import { SafeStore, SafeTree, SafeTooLargeError, emptySafeTree, padState, safeChildren, safeTreeOf, type SafeTreeState } from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const names = (u: Parameters<typeof safeChildren>[0], p = "root") => safeChildren(u, p).map((n) => n.name);

describe("the Safe's tree", () => {
  it("folders, rename, move, trash/restore, the Gallery; the account's log untouched", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const tree = new SafeTree(new SafeStore<SafeTreeState>(a.api, a.key, a.accountId), { id: "dev-A", name: "laptop" });
    let u = await tree.create("correct horse battery staple", FAST);
    let r = await tree.mkdir(u, "Dokumenty");
    u = r.safe;
    expect(r.result.outcome).toBe("applied");
    const docs = safeChildren(u, "root")[0]!.id;
    u = (await tree.mkdir(u, "Skany", docs)).safe;
    u = (await tree.mkdir(u, "dokumenty")).safe; // rule 2: the name is taken (case-insensitive) → suffixed
    expect(names(u)).toEqual(["Dokumenty", "dokumenty (2)"]);
    const scans = safeChildren(u, docs)[0]!.id;
    u = (await tree.rename(u, scans, "Paszporty")).safe;
    u = (await tree.move(u, scans, "root")).safe;
    expect(names(u)).toEqual(["Dokumenty", "dokumenty (2)", "Paszporty"]);
    u = (await tree.trash(u, scans)).safe;
    expect(names(u)).not.toContain("Paszporty");
    u = (await tree.restore(u, scans)).safe;
    expect(names(u)).toContain("Paszporty");
    // The Safe has a Gallery part too (its own root, made by the first rules-4 entry).
    u = (await tree.mkdir(u, "Prywatne zdjęcia", GALLERY_ID)).safe;
    expect(names(u, GALLERY_ID)).toEqual(["Prywatne zdjęcia"]);
    expect(checkInvariants(safeTreeOf(u))).toEqual([]);
    // Nothing went through the account's log.
    const db = (srv as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { n: number } } } }).db;
    expect(db.prepare("SELECT count(*) AS n FROM log WHERE account_id = ?").get(a.accountId).n).toBe(0);
  }, 60_000);

  it("two devices at once: the rules decide (rule 2 names, rule 4 into a trashed folder → recovered)", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const ta = new SafeTree(new SafeStore<SafeTreeState>(a.api, a.key, a.accountId), { id: "dev-A", name: "laptop" });
    const tb = new SafeTree(new SafeStore<SafeTreeState>(b.api, a.key, a.accountId), { id: "dev-B", name: "phone" });
    let ua = await ta.create("correct horse battery staple", FAST);
    ua = (await ta.mkdir(ua, "Wspólny")).safe;
    const shared = safeChildren(ua, "root")[0]!.id;
    let ub = await new SafeStore<SafeTreeState>(b.api, a.key, a.accountId).unlock("correct horse battery staple");
    // Both make "Notatki" from the same state: the second one lands as "Notatki (2)" (rule 2), nothing lost.
    ua = (await ta.mkdir(ua, "Notatki")).safe;
    const rb = await tb.mkdir(ub, "Notatki");
    ub = rb.safe;
    expect(names(ub)).toEqual(["Notatki", "Notatki (2)", "Wspólny"]);
    // A trashes the shared folder; B, not having seen it, makes a folder in it: rule 4 → recovered.
    ua = (await ta.trash(ua, shared)).safe;
    const r4 = await tb.mkdir(ub, "Nowe", shared);
    expect(r4.result.notices.map((n) => n.code)).toContain("moved_to_recovered");
    expect(names(r4.safe, RECOVERED_ID)).toEqual(["Nowe"]);
    expect(checkInvariants(safeTreeOf(r4.safe))).toEqual([]);
  }, 60_000);

  it("size: how many nodes one Safe holds (1 MiB padded state), then a clear error", async () => {
    // Counted in memory (the same tree and padding), then one real write over the limit.
    const t = initIndex(new MemoryIndexStore());
    let n = 0;
    for (; n < 20_000; n++) {
      applyEntry(t, { opId: `op-${String(n).padStart(8, "0")}`, rulesVersion: RULES_VERSION, baseSeq: n, device: { id: "dev-A", name: "laptop" }, createdAt: 1, op: { type: "create", kind: "folder", nodeId: `node-${String(n).padStart(8, "0")}`, parentId: "root", name: `folder ${String(n).padStart(6, "0")} ${"x".repeat(26)}` }, seq: n + 1, serverTime: 1 });
      try {
        padState(new TextEncoder().encode(JSON.stringify({ v: 1, tree: takeSnapshot(t) })));
      } catch (e) {
        expect(e).toBeInstanceOf(SafeTooLargeError);
        break;
      }
    }
    console.log(JSON.stringify({ safeFoldersFit: n }));
    expect(n).toBeGreaterThan(3000);
    const { url } = await startServer();
    const a = await newAccount(url);
    const store = new SafeStore<SafeTreeState>(a.api, a.key, a.accountId);
    const u = await store.create("correct horse battery staple", emptySafeTree(), FAST);
    await expect(store.update(u, () => ({ v: 1, tree: takeSnapshot(t) }))).rejects.toBeInstanceOf(SafeTooLargeError);
    // The stored Safe is unchanged.
    expect((await store.unlock("correct horse battery staple")).revision).toBe(1);
  }, 120_000);
});
