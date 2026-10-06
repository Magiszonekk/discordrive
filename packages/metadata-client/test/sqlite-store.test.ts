import fc from "fast-check";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalState, checkInvariants, replay, MemoryIndexStore, ROOT_ID, type LogEntry } from "@ddv4/sync-core";
// The stage-1 randomized simulation (3–4 devices, offline, uploads, GC, joins).
import { actionArb as simActionArb, lastLog, newStats, runCase, type Action } from "../../sync-core/test/sim.js";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";

// sync-core has its own fast-check copy; arbitraries are duck-typed at runtime.
const actionArb = simActionArb as unknown as fc.Arbitrary<Action>;
const RUNS = Number(process.env.SQLITE_RUNS ?? 40);

describe("SqliteIndexStore (koncept §4.1, tree on disk)", () => {
  it(`gives the same state as MemoryIndexStore on ${RUNS} random stage-1 logs`, () => {
    const stats = newStats();
    let compared = 0;
    let entries = 0;
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 30, maxLength: 200, size: "max" }), (actions) => {
        runCase(actions, stats);
        const log = lastLog() as LogEntry[];
        const mem = replay(log, new MemoryIndexStore());
        const sql = new SqliteIndexStore();
        const r = replay(log, sql);
        expect(r.results.map((x) => x.outcome)).toEqual(mem.results.map((x) => x.outcome));
        expect(canonicalState(sql)).toBe(canonicalState(mem.store));
        expect(checkInvariants(sql)).toEqual([]);
        sql.close();
        compared++;
        entries += log.length;
      }),
      { numRuns: RUNS },
    );
    expect(compared).toBe(RUNS);
    console.log(JSON.stringify({ sqliteCompared: compared, entries }));
  });

  it("persists across reopen, enforces unique live names, rolls back a failed transaction", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-sqlite-"));
    const path = join(dir, "index.db");
    const log: LogEntry[] = [
      { opId: "op-00000001", rulesVersion: 2, baseSeq: 0, device: { id: "d1", name: "d" }, createdAt: 0, seq: 1, serverTime: 0, op: { type: "create", kind: "folder", nodeId: "fold-0001", parentId: ROOT_ID, name: "Foto" } },
      { opId: "op-00000002", rulesVersion: 2, baseSeq: 0, device: { id: "d2", name: "d" }, createdAt: 0, seq: 2, serverTime: 0, op: { type: "create", kind: "folder", nodeId: "fold-0002", parentId: ROOT_ID, name: "FOTO" } },
    ];
    const a = new SqliteIndexStore(path);
    replay(log, a);
    const state = canonicalState(a);
    expect(a.getNode("fold-0002")!.name).toBe("FOTO (2)"); // rule 2 through SQLite
    expect(() => a.atomically(() => {
      a.putNode({ ...a.getNode("fold-0002")!, name: "foto" });
    })).toThrow(/unique name/);
    a.close();
    const b = new SqliteIndexStore(path);
    expect(canonicalState(b)).toBe(state);
    expect(b.getMeta().headSeq).toBe(2);
    b.close();
  });

  it("pages a large folder by keyset without loading it whole", () => {
    const s = new SqliteIndexStore();
    const N = 5000;
    const entries: LogEntry[] = [];
    for (let i = 0; i < N; i++) {
      entries.push({
        opId: `op-${String(i).padStart(8, "0")}`, rulesVersion: 2, baseSeq: 0, device: { id: "d1", name: "d" }, createdAt: 0, seq: i + 1, serverTime: 0,
        op: { type: "create", kind: "folder", nodeId: `fold-${String(i).padStart(6, "0")}`, parentId: ROOT_ID, name: `Plik ${N - i}` },
      });
    }
    replay(entries, s);
    expect(s.countChildren(ROOT_ID)).toBe(N);
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = s.listChildren(ROOT_ID, { after, limit: 300 });
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(300);
      seen.push(...page.map((r) => r.name));
      after = page.at(-1)!.cursor;
      pages++;
    }
    expect(pages).toBe(Math.ceil(N / 300));
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
    const folded = seen.map((x) => x.toLowerCase());
    expect([...folded].sort()).toEqual(folded);
  });
});
