// Local derived tables (zlecenie 2026-10-13-webhooki p. 1-2): current versions, piece locations,
// unavailable uploads; Settings → Storage totals, per-channel stats, the remove dialog list,
// hidden unavailable files. Plus the measurement the order asks for: 50 000 files, 2 000 000
// fragments over 4 channels.
import { describe, expect, it } from "vitest";
import { ROOT_ID, RULES_VERSION, replay, type LogEntry, type Operation } from "@ddv4/sync-core";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";
import { encodeManifestRef } from "../src/drive-client.js";

const H = ["111111111111111111", "222222222222222222", "333333333333333333", "444444444444444444"];

function log(files: { id: string; parent?: string; chunks: number; size: number; pieces?: boolean }[], folders: { id: string; parent?: string }[] = []) {
  const out: LogEntry[] = [];
  const add = (op: Operation, leaseGuard?: string[]) =>
    out.push({ opId: `op-${String(out.length + 1).padStart(8, "0")}`, rulesVersion: RULES_VERSION, baseSeq: out.length, device: { id: "d1", name: "d" }, createdAt: 0, ...(leaseGuard ? { leaseGuard } : {}), op, seq: out.length + 1, serverTime: out.length });
  for (const f of folders) add({ type: "create", kind: "folder", nodeId: f.id, parentId: f.parent ?? ROOT_ID, name: f.id });
  let k = 0;
  for (const f of files) {
    const u = `upl-${f.id}`;
    const mh = H[k++ % H.length]!;
    // Fragments round-robin over the 4 channels, 10 MiB each (+ the manifest on one of them).
    const per = new Map<string, { n: number; bytes: number }>();
    for (let i = 0; i < f.chunks; i++) {
      const h = H[(k + i) % H.length]!;
      const x = per.get(h) ?? { n: 0, bytes: 0 };
      x.n++;
      x.bytes += 10 * 1024 * 1024;
      per.set(h, x);
    }
    const m = per.get(mh) ?? { n: 0, bytes: 0 };
    m.n++;
    m.bytes += 300;
    per.set(mh, m);
    const pieces = [...per].sort(([a], [b]) => (a < b ? -1 : 1)).map(([loc, x]) => ({ loc, ...x }));
    const manifestRef = encodeManifestRef({ v: 1, f: 1, k: "AAAA", at: { provider: "discord-webhook", locationId: mh, channelId: "1", messageId: "2", attachmentId: "3" } });
    add({ type: "upload_begin", uploadId: u }, [u]);
    add(
      { type: "group", ops: [{ type: "upload_commit", uploadId: u }, { type: "create", kind: "file", nodeId: f.id, parentId: f.parent ?? ROOT_ID, name: `${f.id}.bin`, content: { versionId: `ver-${f.id}`, uploadId: u, sizeBytes: f.size, manifestRef, chunkCount: f.chunks, ...(f.pieces === false ? {} : { pieces }) } }] },
      [u],
    );
  }
  return out;
}

describe("derived tables in the local index (schema 2)", () => {
  it("totals: all files, trash (also inside a trashed folder), unavailable; hidden from lists and counters", () => {
    const s = new SqliteIndexStore();
    const entries = log(
      [
        { id: "file0001", chunks: 3, size: 1000 },
        { id: "file0002", chunks: 1, size: 24 },
        { id: "file0003", parent: "fold0001", chunks: 2, size: 500 },
        { id: "file0004", chunks: 1, size: 7, pieces: false },
      ],
      [{ id: "fold0001" }],
    );
    replay(entries, s);
    expect(s.storageTotals()).toMatchObject({ files: 4, bytes: 1531, trashFiles: 0, unavailableFiles: 0 });
    // Trash the folder: the file inside counts as trash (node or ancestor).
    replay([{ ...entries[0]!, opId: "op-trash-001", seq: entries.length + 1, baseSeq: entries.length, op: { type: "trash", nodeId: "fold0001" } }], s);
    expect(s.storageTotals()).toMatchObject({ files: 3, bytes: 1031, trashFiles: 1, trashBytes: 500 });
    // A version without pieces (rules 2 / old client): only its manifest's place is known, marked incomplete.
    expect(s.versionsWithoutPieces().map((x) => x.uploadId)).toEqual(["upl-file0004"]);
    // Webhook H[0] removed: every file with a piece there is unavailable (computed, not in the log).
    const out = s.uploadsOutside(H.slice(1));
    expect(out.map((x) => x.uploadId).sort()).toEqual(["upl-file0001", "upl-file0002", "upl-file0003"].filter((u) => out.some((x) => x.uploadId === u)));
    s.setUnavailable(out);
    const t = s.storageTotals();
    expect(t.unavailableFiles).toBe(out.length);
    const shown = s.listChildren(ROOT_ID, { hideUnavailable: true }).map((r) => r.id);
    const all = s.listChildren(ROOT_ID).map((r) => r.id);
    for (const r of out) {
      const node = r.uploadId.replace("upl-", "");
      if (all.includes(node)) expect(shown).not.toContain(node);
    }
    expect(s.countChildren(ROOT_ID, true)).toBe(shown.length);
    expect(s.listChildren(ROOT_ID).find((r) => out.some((u) => u.uploadId === `upl-${r.id}`))?.unavailable).toEqual(expect.arrayContaining([H[0]]));
    expect(s.folderStats(ROOT_ID, true).files).toBe(shown.filter((id) => id.startsWith("file")).length);
    // Pasting it again: nothing outside the vault, the files are back.
    s.setUnavailable(s.uploadsOutside(H));
    expect(s.storageTotals().unavailableFiles).toBe(0);
    expect(s.countChildren(ROOT_ID, true)).toBe(s.countChildren(ROOT_ID));
  });

  it("per channel: files and bytes; the remove-dialog list; the mover's work list; purge drops the rows", () => {
    const s = new SqliteIndexStore();
    const entries = log([
      { id: "file0001", chunks: 4, size: 40 },
      { id: "file0002", chunks: 1, size: 10 },
    ]);
    replay(entries, s);
    const st = s.locationStats();
    const files = [...st.values()].reduce((a, x) => a + x.files, 0);
    expect(files).toBeGreaterThanOrEqual(2);
    const at = s.filesAt(H[1]!);
    expect(at.total).toBe(at.rows.length);
    expect(s.versionsAt(H[1]!).length).toBe(at.total);
    // Purge file0001: its rows leave the joins at once, the table is pruned on demand.
    const n = entries.length;
    replay(
      [
        { ...entries[0]!, opId: "op-t-000001", seq: n + 1, baseSeq: n, op: { type: "trash", nodeId: "file0001" } },
        { ...entries[0]!, opId: "op-p-000001", seq: n + 2, baseSeq: n + 1, op: { type: "purge", nodeId: "file0001" } },
      ],
      s,
    );
    expect(s.storageTotals().files).toBe(1);
    expect([...s.locationStats().values()].reduce((a, x) => a + x.files, 0)).toBeLessThan(files);
    expect(s.prunePieces()).toBeGreaterThan(0);
  });

  it("a schema-1 database is migrated in place (files filled from the tree)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "ddn-mig-")), "i.db");
    const a = new SqliteIndexStore(path);
    replay(log([{ id: "file0001", chunks: 2, size: 9 }]), a);
    // Back to schema 1: drop the derived tables and the version mark, like a database written before.
    a.sql.exec("DROP TABLE files; DROP TABLE pieces; DROP TABLE piece_src; DROP TABLE unavail; UPDATE meta SET v = '1' WHERE k = 'schema';");
    a.close();
    const b = new SqliteIndexStore(path);
    expect(b.storageTotals()).toMatchObject({ files: 1, bytes: 9 });
    expect(b.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'", [])!.v).toBe("3"); // straight to the current schema (2: derived tables, 3: sort columns)
  });

  it("measured: 50 000 files, 2 000 000 fragments over 4 channels - totals, per channel, one channel's list, unavailable", () => {
    const s = new SqliteIndexStore();
    const files = Array.from({ length: 50_000 }, (_, i) => ({ id: `f${String(i).padStart(7, "0")}`, chunks: 40, size: 40 * 10 * 1024 * 1024 }));
    const t0 = performance.now();
    s.atomically(() => replay(log(files), s));
    const tLoad = performance.now() - t0;
    const pieceRows = s.sql.get<{ n: number }>("SELECT count(*) AS n FROM pieces", [])!.n;
    const frags = s.sql.get<{ n: number }>("SELECT sum(n) AS n FROM pieces", [])!.n;
    const time = (f: () => unknown) => {
      const t = performance.now();
      f();
      return Math.round((performance.now() - t) * 10) / 10;
    };
    const ms = {
      totals: time(() => s.storageTotals()),
      perChannel: time(() => s.locationStats()),
      removeDialog: time(() => s.filesAt(H[2]!)),
      unavailable: time(() => s.setUnavailable(s.uploadsOutside(H.slice(1)))),
      totalsAfter: time(() => s.storageTotals()),
      listHidden: time(() => s.listChildren(ROOT_ID, { hideUnavailable: true, limit: 50 })),
    };
    console.log(JSON.stringify({ files: 50_000, fragments: frags, pieceRows, replayMs: Math.round(tLoad), ...ms }));
    expect(frags).toBe(2_000_000 + 50_000); // 40 fragments + 1 manifest per file
    expect(s.storageTotals().unavailableFiles).toBe(50_000); // every file has a piece on each channel
    for (const v of Object.values(ms)) expect(v).toBeLessThan(2000);
  }, 300_000);
});
