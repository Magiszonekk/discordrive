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

describe("SqliteIndexStore (tree on disk)", () => {
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
    // Folder heading counters come from the same index (folders only here).
    expect(s.folderStats(ROOT_ID)).toEqual({ folders: N, files: 0, bytes: 0 });
  });

  it("sorts (name / size / date, both directions): folders first, keyset pages = the full sort, on an index; schema 2 -> 3", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-sort-"));
    const path = join(dir, "index.db");
    const s = new SqliteIndexStore(path);
    const rec = (id: string, kind: "file" | "folder", name: string, size: number | null, at: number) => ({
      id, kind, name, parentId: ROOT_ID, trashed: null,
      created: { seq: 1, deviceId: "d" }, nameChanged: { seq: 1, deviceId: "d" }, placed: { seq: 1, deviceId: "d" },
      content: size === null ? null : ({ sizeBytes: size, createdAt: at } as never), recoveredFrom: null, conflictOf: null,
    });
    // Ties on purpose (same size / same date) so the name/ID tie-break is exercised across page edges.
    for (let i = 0; i < 37; i++) s.putNode(rec(`fold-${i}`, "folder", `Dir ${(i * 7) % 37}`, null, 0));
    for (let i = 0; i < 211; i++) s.putNode(rec(`file-${String(i).padStart(3, "0")}`, "file", `f${(i * 13) % 211}.bin`, (i % 9) * 1000, 1_700_000_000_000 + (i % 5) * 60_000));
    const all = (sort: { by: "name" | "size" | "date"; desc?: boolean }, page: number) => {
      const out: { id: string; kind: string; name: string; size: number | null; modifiedAt: number | null }[] = [];
      let after: string | undefined;
      for (;;) {
        const pg = s.listChildren(ROOT_ID, { after, limit: page, sort });
        if (!pg.length) break;
        out.push(...pg);
        after = pg.at(-1)!.cursor;
      }
      return out;
    };
    const key = (r: { kind: string; name: string; size: number | null; modifiedAt: number | null; id: string }, by: string) => [r.kind === "folder" ? 0 : 1, by === "size" ? (r.size ?? 0) : by === "date" ? (r.modifiedAt ?? 0) : 0, r.name.toLowerCase(), r.id] as const;
    for (const by of ["name", "size", "date"] as const)
      for (const desc of [false, true]) {
        const got = all({ by, desc }, 23);
        expect(got.length).toBe(248);
        expect(new Set(got.map((r) => r.id)).size).toBe(248);
        expect(got.slice(0, 37).every((r) => r.kind === "folder")).toBe(true); // folders first in both directions
        const sign = desc ? -1 : 1;
        const want = [...got].sort((a, b) => {
          const x = key(a, by), y = key(b, by);
          if (x[0] !== y[0]) return x[0] - y[0];
          for (let i = 1; i < 4; i++) if (x[i] !== y[i]) return sign * (x[i]! < y[i]! ? -1 : 1);
          return 0;
        });
        expect(got.map((r) => r.id), `${by} ${desc}`).toEqual(want.map((r) => r.id));
        // The same order with one big page (no cursor) and with pages of 1.
        expect(all({ by, desc }, 1000).map((r) => r.id)).toEqual(got.map((r) => r.id));
      }
    // Every sort reads an index (no full scan of the table, no temp B-tree for ORDER BY).
    for (const [col, ix] of [["name_key", "nodes_by_name"], ["sz", "nodes_by_size"], ["mt", "nodes_by_date"]] as const) {
      const plan = s.sql.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE parent_id = ? AND fo = 1 ORDER BY ${col === "name_key" ? "" : `${col} DESC, `}name_key DESC, id DESC LIMIT 50`, [ROOT_ID]).map((r) => r.detail).join(" | ");
      expect(plan, col).toContain(ix);
      expect(plan, col).not.toMatch(/TEMP B-TREE/);
    }
    // An old cursor (schema 2: [nameKey, id]) starts over instead of failing.
    expect(s.listChildren(ROOT_ID, { after: JSON.stringify(["dir 1", "fold-1"]), limit: 5 })[0]!.kind).toBe("folder");
    // Schema 2 database (no sort columns, no sort indexes): opened, migrated, same order.
    const before = all({ by: "size", desc: true }, 50).map((r) => r.id);
    s.sql.exec("DROP INDEX nodes_by_name; DROP INDEX nodes_by_size; DROP INDEX nodes_by_date; ALTER TABLE nodes DROP COLUMN fo; ALTER TABLE nodes DROP COLUMN sz; ALTER TABLE nodes DROP COLUMN mt; UPDATE meta SET v = '2' WHERE k = 'schema';");
    s.close();
    const b = new SqliteIndexStore(path);
    expect(b.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'", [])!.v).toBe("3");
    let after: string | undefined;
    const again: string[] = [];
    for (;;) {
      const pg = b.listChildren(ROOT_ID, { after, limit: 50, sort: { by: "size", desc: true } });
      if (!pg.length) break;
      again.push(...pg.map((r) => r.id));
      after = pg.at(-1)!.cursor;
    }
    expect(again).toEqual(before);
    b.close();
  });

  it("folderStats: live sub-folders, files and their bytes; trashed nodes not counted", () => {
    const s = new SqliteIndexStore();
    const rec = (id: string, kind: "file" | "folder", size: number | null, trashed = false) => ({
      id, kind, name: id, parentId: ROOT_ID, trashed: trashed ? { seq: 9, at: 0 } : null,
      created: { seq: 1, deviceId: "d" }, nameChanged: { seq: 1, deviceId: "d" }, placed: { seq: 1, deviceId: "d" },
      content: size === null ? null : ({ sizeBytes: size, createdAt: 1_700_000_000_000 } as never), recoveredFrom: null, conflictOf: null,
    });
    s.putNode(rec("a", "folder", null));
    s.putNode(rec("b", "file", 1000));
    s.putNode(rec("c", "file", 24));
    s.putNode(rec("d", "file", 5000, true));
    expect(s.folderStats(ROOT_ID)).toEqual({ folders: 1, files: 2, bytes: 1024 });
    expect(s.listChildren(ROOT_ID).find((r) => r.id === "b")!.modifiedAt).toBe(1_700_000_000_000);
    expect(s.listChildren(ROOT_ID).find((r) => r.id === "a")!.modifiedAt).toBeNull();
  });
});
