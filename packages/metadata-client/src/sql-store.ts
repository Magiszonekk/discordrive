// Tree layer on disk: one IndexStore implementation over a
// minimal synchronous SQL driver, shared by
//   - Node/CLI: node:sqlite (node/sqlite-store.ts),
//   - browser:  SQLite-WASM on OPFS, SAH-pool VFS, in a dedicated worker
//               (browser/opfs-store.ts).
// Both drivers are synchronous, so apply() stays synchronous (sync-core store.ts).
//
// Schema mirrors the MemoryIndexStore contract:
//  - records stored as JSON (the core treats them as immutable values),
//  - indexed columns for what the core and the UI query:
//      (parent_id, name_key, id) children, keyset paging for virtualized lists
//      partial UNIQUE (parent_id, name_key) WHERE live: the rule-2 uniqueness
//      guarantee is enforced by the database itself, like the memory store's throw.
//  - atomically() = one transaction (OverlayStore.commit runs inside it).
// Keyset cursor is a JSON pair, never a NUL-joined string: node:sqlite truncates
// TEXT at U+0000.

import { nameKey, type IndexMeta, type IndexStore, type NodeId, type NodeRecord, type PieceLoc, type UploadId, type UploadRecord } from "@ddv4/sync-core";

export type SqlValue = string | number | null;

/** The few synchronous operations the store needs. */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params: SqlValue[]): { changes: number };
  get<T>(sql: string, params: SqlValue[]): T | undefined;
  all<T>(sql: string, params: SqlValue[]): T[];
  close(): void;
}

/**
 * 1: tree + uploads. 2: derived tables next to it, migrated in place
 * (a schema-1 database is opened and extended, nothing is rebuilt):
 *   pieces       where the pieces of each version are, per location (from content.pieces, rules v3,
 *                or filled by the client from the manifest: setPieces) - per-channel stats, the
 *                remove-channel impact and unavailability without loading manifests;
 *   piece_src    for which manifestRef the rows of an upload were made, and whether they are complete
 *                (only the manifest's own location is known until the manifest was read);
 *   unavail      uploads that cannot be read now (a piece on a channel no longer in the account);
 *                computed by the client (metadata only: vault + pieces; e2ee/plain: the instance),
 *                never an operation, so re-pasting a webhook makes them readable at once everywhere.
 * The derived rows never feed back into the tree (apply() does not read them).
 */
const SCHEMA_VERSION = 3;
// 3: sort columns on nodes (fo: 0 folder / 1 file, sz: size, mt: modified),
//   filled from the record by putNode, with one index per sort (parent_id, fo, key, name_key, id), so
//   every sort pages by keyset over an index (no OFFSET, no temp B-tree), folders first.

/** Sort of a folder listing; folders always come first, ties by name then ID (same direction). */
export interface ListSort {
  by: "name" | "size" | "date";
  desc?: boolean;
}

export interface ChildRow {
  id: NodeId;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  /** Files: when the current version was written (author's clock, display only). Folders: null. */
  modifiedAt: number | null;
  trashed: boolean;
  /** Opaque keyset cursor for the next page. */
  cursor: string;
  /** Unavailable file: the locations (webhook IDs) its missing pieces are on. */
  unavailable?: string[];
}

export interface FolderStats {
  folders: number;
  files: number;
  bytes: number;
}

/**
 * Location (backend ID) of a version's manifest, from its manifestRef ("ddn1:[v,f,k,loc,…]" for Discord,
 * "ddn2:[2,f,k,provider,loc,…]" for other backends), without importing the client.
 */
export function manifestLoc(ref: string): string | null {
  const v1 = ref.startsWith("ddn1:");
  if (!v1 && !ref.startsWith("ddn2:")) return null;
  try {
    const a = JSON.parse(ref.slice(5)) as unknown[];
    if (!Array.isArray(a)) return null;
    return v1 ? (a.length === 7 ? String(a[3]) : null) : a.length === 6 ? String(a[4]) : null;
  } catch {
    return null;
  }
}

export class SqlIndexStore implements IndexStore {
  private depth = 0;
  /** files.trashed may be stale for nodes inside a folder whose trash state changed (refreshTrash before reading it). */
  private trashDirty = true;

  constructor(readonly sql: SqlDriver) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_key TEXT NOT NULL,
        live INTEGER NOT NULL,
        rec TEXT NOT NULL,
        fo INTEGER NOT NULL DEFAULT 1,
        sz INTEGER NOT NULL DEFAULT 0,
        mt INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS nodes_children ON nodes(parent_id, name_key, id);
      CREATE UNIQUE INDEX IF NOT EXISTS nodes_unique_name ON nodes(parent_id, name_key) WHERE live = 1 AND parent_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, rec TEXT NOT NULL);
    `);
    const ver = sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'", []);
    if (!ver) sql.run("INSERT INTO meta (k, v) VALUES ('schema', ?)", [String(SCHEMA_VERSION)]);
    else if (Number(ver.v) > SCHEMA_VERSION || Number(ver.v) < 1) throw new Error(`index schema ${ver.v} not supported (want ${SCHEMA_VERSION}); rebuild from log`);
    this.migrate(Number(ver?.v ?? SCHEMA_VERSION));
  }

  /** Schema 1 -> 2: derived tables; the files table is filled from the tree once. */
  private migrate(from: number): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        upload_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        size INTEGER NOT NULL,
        manifest_ref TEXT NOT NULL,
        chunks INTEGER NOT NULL,
        trashed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_node ON files(node_id);
      CREATE TABLE IF NOT EXISTS pieces (upload_id TEXT NOT NULL, loc TEXT NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (upload_id, loc));
      CREATE INDEX IF NOT EXISTS pieces_loc ON pieces(loc, upload_id);
      CREATE TABLE IF NOT EXISTS piece_src (upload_id TEXT PRIMARY KEY, manifest_ref TEXT NOT NULL, complete INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS unavail (upload_id TEXT PRIMARY KEY, locs TEXT NOT NULL);
    `);
    if (from < 2) {
      this.atomically(() => {
        for (const r of this.sql.all<{ rec: string }>("SELECT rec FROM nodes WHERE json_extract(rec, '$.kind') = 'file'", [])) this.indexFile(JSON.parse(r.rec) as NodeRecord);
      });
    }
    if (from < 3) {
      // Schema 2 -> 3: sort columns, filled from the records in one statement.
      this.atomically(() => {
        const cols = new Set(this.sql.all<{ name: string }>("PRAGMA table_info(nodes)", []).map((c) => c.name));
        if (!cols.has("fo")) this.sql.exec("ALTER TABLE nodes ADD COLUMN fo INTEGER NOT NULL DEFAULT 1");
        if (!cols.has("sz")) this.sql.exec("ALTER TABLE nodes ADD COLUMN sz INTEGER NOT NULL DEFAULT 0");
        if (!cols.has("mt")) this.sql.exec("ALTER TABLE nodes ADD COLUMN mt INTEGER NOT NULL DEFAULT 0");
        this.sql.run(
          "UPDATE nodes SET fo = CASE json_extract(rec, '$.kind') WHEN 'folder' THEN 0 ELSE 1 END, sz = coalesce(json_extract(rec, '$.content.sizeBytes'), 0), mt = coalesce(json_extract(rec, '$.content.createdAt'), 0)",
          [],
        );
      });
    }
    if (from < SCHEMA_VERSION) this.sql.run("UPDATE meta SET v = ? WHERE k = 'schema'", [String(SCHEMA_VERSION)]);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS nodes_by_name ON nodes(parent_id, fo, name_key, id);
      CREATE INDEX IF NOT EXISTS nodes_by_size ON nodes(parent_id, fo, sz, name_key, id);
      CREATE INDEX IF NOT EXISTS nodes_by_date ON nodes(parent_id, fo, mt, name_key, id);
    `);
  }

  /**
   * files: one row per CURRENT version (upload bound to a file node), with the node's own trash
   * flag resolved lazily (trashed = node or ancestor, recomputed by refreshTrash; the tree has no
   * cheap "inside a trashed folder" column). Kept in step by putNode/deleteNode.
   */
  private indexFile(n: NodeRecord): void {
    this.sql.run("DELETE FROM files WHERE node_id = ?", [n.id]);
    if (n.kind !== "file" || !n.content || typeof n.content.uploadId !== "string" || typeof n.content.manifestRef !== "string") return;
    const c = n.content;
    this.sql.run("INSERT OR REPLACE INTO files (upload_id, node_id, size, manifest_ref, chunks, trashed) VALUES (?, ?, ?, ?, ?, ?)", [
      c.uploadId,
      n.id,
      c.sizeBytes,
      c.manifestRef,
      c.chunkCount,
      n.trashed ? 1 : 0,
    ]);
    // Piece rows follow the version's locator: a new manifestRef (new version, relocate) drops the old rows.
    const src = this.sql.get<{ manifest_ref: string }>("SELECT manifest_ref FROM piece_src WHERE upload_id = ?", [c.uploadId]);
    if (c.pieces) {
      if (src?.manifest_ref !== c.manifestRef || !this.sql.get("SELECT 1 FROM piece_src WHERE upload_id = ? AND complete = 1", [c.uploadId])) this.setPieces(c.uploadId, c.manifestRef, c.pieces, true);
    } else if (!src || src.manifest_ref !== c.manifestRef) {
      // Version without piece locations (rules 2, or an older client): only the manifest's own place
      // is known from its locator; the client reads the manifest later and completes the rows.
      const loc = manifestLoc(c.manifestRef);
      if (loc) this.setPieces(c.uploadId, c.manifestRef, [{ loc, n: 1, bytes: 0 }], false);
      else {
        this.sql.run("DELETE FROM pieces WHERE upload_id = ?", [c.uploadId]);
        this.sql.run("DELETE FROM piece_src WHERE upload_id = ?", [c.uploadId]);
      }
    }
  }

  /** Piece locations of a version (rules v3 content, or read from its manifest by the client). */
  setPieces(uploadId: string, manifestRef: string, pieces: PieceLoc[], complete: boolean): void {
    this.sql.run("DELETE FROM pieces WHERE upload_id = ?", [uploadId]);
    for (const p of pieces) this.sql.run("INSERT INTO pieces (upload_id, loc, n, bytes) VALUES (?, ?, ?, ?)", [uploadId, p.loc, p.n, p.bytes]);
    this.sql.run("INSERT INTO piece_src (upload_id, manifest_ref, complete) VALUES (?, ?, ?) ON CONFLICT(upload_id) DO UPDATE SET manifest_ref = excluded.manifest_ref, complete = excluded.complete", [uploadId, manifestRef, complete ? 1 : 0]);
  }

  /** Current versions whose piece locations are not known completely yet (the client reads their manifests). */
  versionsWithoutPieces(limit = 500): { uploadId: string; manifestRef: string }[] {
    return this.sql
      .all<{ upload_id: string; manifest_ref: string }>(
        "SELECT f.upload_id, f.manifest_ref FROM files f LEFT JOIN piece_src s ON s.upload_id = f.upload_id AND s.manifest_ref = f.manifest_ref AND s.complete = 1 WHERE s.upload_id IS NULL ORDER BY f.upload_id LIMIT ?",
        [limit],
      )
      .map((r) => ({ uploadId: r.upload_id, manifestRef: r.manifest_ref }));
  }

  /**
   * "Inside the trash" for every current version (node or an ancestor trashed), refreshed in one
   * pass over the trashed nodes: a recursive walk down from each top-level trashed node. Called
   * after a pull that changed something; cheap when the trash is small (the usual case).
   */
  refreshTrash(): void {
    if (!this.trashDirty) return;
    this.trashDirty = false;
    this.atomically(() => {
      this.sql.run("UPDATE files SET trashed = 0 WHERE trashed = 1", []);
      this.sql.run(
        `WITH RECURSIVE t(id) AS (SELECT id FROM nodes WHERE live = 0 AND parent_id IS NOT NULL
           UNION SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
         UPDATE files SET trashed = 1 WHERE node_id IN (SELECT id FROM t)`,
        [],
      );
    });
  }

  /** Replace the set of unavailable uploads (computed by the mode; see the schema comment). */
  setUnavailable(rows: { uploadId: string; locs: string[] }[]): void {
    this.atomically(() => {
      this.sql.run("DELETE FROM unavail", []);
      for (const r of rows) this.sql.run("INSERT OR REPLACE INTO unavail (upload_id, locs) VALUES (?, ?)", [r.uploadId, JSON.stringify(r.locs)]);
    });
  }

  /**
   * metadata only: uploads with a piece on a location that is not in `known` (the vault's webhooks).
   * Pure SQL over the pieces table, so it is instant also for 50 000 files / 2 M pieces.
   */
  uploadsOutside(known: string[]): { uploadId: string; locs: string[] }[] {
    const ph = known.map(() => "?").join(",");
    const rows = this.sql.all<{ upload_id: string; loc: string }>(
      `SELECT p.upload_id, p.loc FROM pieces p JOIN files f ON f.upload_id = p.upload_id${known.length ? ` WHERE p.loc NOT IN (${ph})` : ""} ORDER BY p.upload_id, p.loc`,
      known,
    );
    const out = new Map<string, string[]>();
    for (const r of rows) (out.get(r.upload_id) ?? out.set(r.upload_id, []).get(r.upload_id)!).push(r.loc);
    return [...out].map(([uploadId, locs]) => ({ uploadId, locs }));
  }

  unavailable(): { uploadId: string; nodeId: string; locs: string[] }[] {
    return this.sql
      .all<{ upload_id: string; node_id: string; locs: string }>("SELECT u.upload_id, f.node_id, u.locs FROM unavail u JOIN files f ON f.upload_id = u.upload_id", [])
      .map((r) => ({ uploadId: r.upload_id, nodeId: r.node_id, locs: JSON.parse(r.locs) as string[] }));
  }

  isUnavailable(nodeId: NodeId): string[] | null {
    const r = this.sql.get<{ locs: string }>("SELECT u.locs FROM unavail u JOIN files f ON f.upload_id = u.upload_id WHERE f.node_id = ?", [nodeId]);
    return r ? (JSON.parse(r.locs) as string[]) : null;
  }

  /**
   * Settings → Storage: all files (not in the trash), the trash,
   * the unavailable ones (any place; they are counted in their group too). One indexed pass each.
   */
  storageTotals(): { files: number; bytes: number; trashFiles: number; trashBytes: number; unavailableFiles: number; unavailableBytes: number; pieceBytes: number; piecesKnown: number } {
    this.refreshTrash();
    const g = this.sql.all<{ t: number; n: number; b: number | null }>("SELECT trashed AS t, count(*) AS n, sum(size) AS b FROM files GROUP BY trashed", []);
    const live = g.find((x) => Number(x.t) === 0);
    const tr = g.find((x) => Number(x.t) === 1);
    const u = this.sql.get<{ n: number; b: number | null }>("SELECT count(*) AS n, sum(f.size) AS b FROM unavail u JOIN files f ON f.upload_id = u.upload_id", [])!;
    const p = this.sql.get<{ b: number | null; k: number }>("SELECT sum(p.bytes) AS b, count(DISTINCT p.upload_id) AS k FROM pieces p JOIN files f ON f.upload_id = p.upload_id", [])!;
    return {
      files: Number(live?.n ?? 0),
      bytes: Number(live?.b ?? 0),
      trashFiles: Number(tr?.n ?? 0),
      trashBytes: Number(tr?.b ?? 0),
      unavailableFiles: Number(u.n ?? 0),
      unavailableBytes: Number(u.b ?? 0),
      pieceBytes: Number(p.b ?? 0),
      piecesKnown: Number(p.k ?? 0),
    };
  }

  /** Per location: files with a piece there and the bytes stored there (current versions, trash included). */
  locationStats(): Map<string, { files: number; bytes: number }> {
    const rows = this.sql.all<{ loc: string; n: number; b: number }>("SELECT p.loc, count(*) AS n, sum(p.bytes) AS b FROM pieces p JOIN files f ON f.upload_id = p.upload_id GROUP BY p.loc", []);
    return new Map(rows.map((r) => [r.loc, { files: Number(r.n), bytes: Number(r.b) }]));
  }

  /** Files with a piece on `loc` (the remove dialog), by name: node, name, size, trash. */
  filesAt(loc: string, limit = 1000): { total: number; bytes: number; rows: { id: string; name: string; size: number; trashed: boolean }[] } {
    this.refreshTrash();
    const t = this.sql.get<{ n: number; b: number | null }>("SELECT count(*) AS n, sum(f.size) AS b FROM pieces p JOIN files f ON f.upload_id = p.upload_id WHERE p.loc = ?", [loc])!;
    const rows = this.sql.all<{ id: string; rec: string; size: number; trashed: number }>(
      "SELECT n.id, n.rec, f.size, f.trashed FROM pieces p JOIN files f ON f.upload_id = p.upload_id JOIN nodes n ON n.id = f.node_id WHERE p.loc = ? ORDER BY f.trashed, n.name_key, n.id LIMIT ?",
      [loc, limit],
    );
    return {
      total: Number(t.n ?? 0),
      bytes: Number(t.b ?? 0),
      rows: rows.map((r) => ({ id: r.id, name: (JSON.parse(r.rec) as NodeRecord).name, size: Number(r.size), trashed: !!r.trashed })),
    };
  }

  /** Current versions with a piece on `loc` (the mover's work list), in a stable order. */
  versionsAt(loc: string, after = "", limit = 200): { uploadId: string; nodeId: string; manifestRef: string; size: number }[] {
    return this.sql
      .all<{ upload_id: string; node_id: string; manifest_ref: string; size: number }>(
        "SELECT f.upload_id, f.node_id, f.manifest_ref, f.size FROM pieces p JOIN files f ON f.upload_id = p.upload_id WHERE p.loc = ? AND f.upload_id > ? ORDER BY f.upload_id LIMIT ?",
        [loc, after, limit],
      )
      .map((r) => ({ uploadId: r.upload_id, nodeId: r.node_id, manifestRef: r.manifest_ref, size: Number(r.size) }));
  }

  close(): void {
    this.sql.close();
  }

  getMeta(): IndexMeta {
    const r = this.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'index'", []);
    return r ? (JSON.parse(r.v) as IndexMeta) : { headSeq: 0, rulesVersion: 0 };
  }
  setMeta(meta: IndexMeta): void {
    this.sql.run("INSERT INTO meta (k, v) VALUES ('index', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(meta)]);
  }

  getNode(id: NodeId): NodeRecord | undefined {
    const r = this.sql.get<{ rec: string }>("SELECT rec FROM nodes WHERE id = ?", [id]);
    return r ? (JSON.parse(r.rec) as NodeRecord) : undefined;
  }
  putNode(rec: NodeRecord): void {
    try {
      this.sql.run(
        "INSERT INTO nodes (id, parent_id, name_key, live, rec, fo, sz, mt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name_key = excluded.name_key, live = excluded.live, rec = excluded.rec, fo = excluded.fo, sz = excluded.sz, mt = excluded.mt",
        [rec.id, rec.parentId, nameKey(rec.name), rec.trashed === null ? 1 : 0, JSON.stringify(rec), rec.kind === "folder" ? 0 : 1, rec.content?.sizeBytes ?? 0, rec.content?.createdAt ?? 0],
      );
    } catch (e) {
      if (String((e as Error)?.message ?? e).includes("UNIQUE")) throw new Error(`unique name violation in ${rec.parentId}: ${rec.name}`);
      throw e;
    }
    this.trashDirty = true;
    if (rec.kind === "file") this.indexFile(rec);
  }
  deleteNode(id: NodeId): void {
    this.sql.run("DELETE FROM nodes WHERE id = ?", [id]);
    // OverlayStore.commit deletes every touched node before putting it back, so only the files row
    // goes here (putNode re-adds it). Piece and unavailability rows are keyed by upload and stay:
    // they are only read joined with files (current versions), and a manifest read is not repeated.
    this.sql.run("DELETE FROM files WHERE node_id = ?", [id]);
    this.trashDirty = true;
  }

  /** Drop derived rows of uploads that are no current version any more (purged / superseded). */
  prunePieces(): number {
    let n = 0;
    this.atomically(() => {
      n = this.sql.run("DELETE FROM pieces WHERE upload_id NOT IN (SELECT upload_id FROM files)", []).changes;
      this.sql.run("DELETE FROM piece_src WHERE upload_id NOT IN (SELECT upload_id FROM files)", []);
      this.sql.run("DELETE FROM unavail WHERE upload_id NOT IN (SELECT upload_id FROM files)", []);
    });
    return n;
  }
  childIds(parentId: NodeId): Iterable<NodeId> {
    return this.sql.all<{ id: string }>("SELECT id FROM nodes WHERE parent_id = ?", [parentId]).map((r) => r.id);
  }
  childByKey(parentId: NodeId, key: string): NodeId | undefined {
    return this.sql.get<{ id: string }>("SELECT id FROM nodes WHERE parent_id = ? AND name_key = ? AND live = 1", [parentId, key])?.id;
  }

  getUpload(id: UploadId): UploadRecord | undefined {
    const r = this.sql.get<{ rec: string }>("SELECT rec FROM uploads WHERE id = ?", [id]);
    return r ? (JSON.parse(r.rec) as UploadRecord) : undefined;
  }
  putUpload(rec: UploadRecord): void {
    this.sql.run("INSERT INTO uploads (id, rec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec", [rec.id, JSON.stringify(rec)]);
  }

  allNodes(): Iterable<NodeRecord> {
    return this.sql.all<{ rec: string }>("SELECT rec FROM nodes", []).map((r) => JSON.parse(r.rec) as NodeRecord);
  }
  allUploads(): Iterable<UploadRecord> {
    return this.sql.all<{ rec: string }>("SELECT rec FROM uploads", []).map((r) => JSON.parse(r.rec) as UploadRecord);
  }

  atomically<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  /**
   * One page of a folder: folders first, then files, each group by the sort key (name: case-folded
   * name; size; date = the current version's createdAt), ties by name then ID in the same direction.
   * Keyset paging over the per-sort index (no OFFSET; only the visible rows in RAM): one
   * range scan per group (fo is an equality there, so a descending sort is the same index read backwards).
   * Cursor: JSON [fo, key, name_key, id] (key null for the name sort).
   */
  listChildren(parentId: NodeId, opts: { after?: string; limit?: number; includeTrashed?: boolean; hideUnavailable?: boolean; sort?: ListSort } = {}): ChildRow[] {
    const by = opts.sort?.by ?? "name";
    const dir = opts.sort?.desc ? "DESC" : "ASC";
    const cmp = opts.sort?.desc ? "<" : ">";
    const col = by === "size" ? "n.sz" : by === "date" ? "n.mt" : null;
    const cur = parseCursor(opts.after);
    const limit = opts.limit ?? 200;
    const out: ChildRow[] = [];
    for (const fo of [0, 1]) {
      if (out.length >= limit || (cur && cur.fo > fo)) continue;
      const after = cur && cur.fo === fo ? cur : null;
      const keyCols = col ? `(${col}, n.name_key, n.id)` : "(n.name_key, n.id)";
      const keyVals: SqlValue[] = after ? (col ? [after.key ?? 0, after.nameKey, after.id] : [after.nameKey, after.id]) : [];
      const rows = this.sql.all<{ id: string; name_key: string; rec: string; unav: string | null; sz: number; mt: number }>(
        `SELECT n.id, n.name_key, n.rec, n.sz, n.mt, u.locs AS unav FROM nodes n LEFT JOIN files f ON f.node_id = n.id LEFT JOIN unavail u ON u.upload_id = f.upload_id
         WHERE n.parent_id = ? AND n.fo = ?${after ? ` AND ${keyCols} ${cmp} (${keyVals.map(() => "?").join(", ")})` : ""} AND (n.live = 1 OR ? = 1) AND (? = 0 OR u.upload_id IS NULL)
         ORDER BY ${col ? `${col} ${dir}, ` : ""}n.name_key ${dir}, n.id ${dir} LIMIT ?`,
        [parentId, fo, ...keyVals, opts.includeTrashed ? 1 : 0, opts.hideUnavailable ? 1 : 0, limit - out.length],
      );
      for (const r of rows) {
        const n = JSON.parse(r.rec) as NodeRecord;
        out.push({
          id: n.id,
          name: n.name,
          kind: n.kind,
          size: n.content?.sizeBytes ?? null,
          modifiedAt: n.content?.createdAt ?? null,
          trashed: n.trashed !== null,
          cursor: JSON.stringify([fo, by === "size" ? Number(r.sz) : by === "date" ? Number(r.mt) : null, r.name_key, r.id]),
          ...(r.unav ? { unavailable: JSON.parse(r.unav) as string[] } : {}),
        });
      }
    }
    return out;
  }

  countChildren(parentId: NodeId, hideUnavailable = false): number {
    return Number(
      this.sql.get<{ n: number }>(
        "SELECT count(*) AS n FROM nodes n LEFT JOIN files f ON f.node_id = n.id LEFT JOIN unavail u ON u.upload_id = f.upload_id WHERE n.parent_id = ? AND n.live = 1 AND (? = 0 OR u.upload_id IS NULL)",
        [parentId, hideUnavailable ? 1 : 0],
      )!.n,
    );
  }

  /**
   * Nodes trashed on their own (the trash list): `live = 0` is exactly "trashed itself"
   * (children of a trashed folder stay live = 1 and are hidden by the folder).
   */
  trashedNodes(): NodeRecord[] {
    return this.sql.all<{ rec: string }>("SELECT rec FROM nodes WHERE live = 0", []).map((r) => JSON.parse(r.rec) as NodeRecord);
  }

  /** Live sub-folders of a folder, by name (Move to… picker). */
  childFolders(parentId: NodeId, limit = 1000): { id: NodeId; name: string }[] {
    return this.sql
      .all<{ rec: string }>("SELECT rec FROM nodes WHERE parent_id = ? AND live = 1 AND json_extract(rec, '$.kind') = 'folder' ORDER BY name_key, id LIMIT ?", [parentId, limit])
      .map((r) => {
        const n = JSON.parse(r.rec) as NodeRecord;
        return { id: n.id, name: n.name };
      });
  }

  /** Folder heading counters: direct sub-folders, files and the bytes of those files (one indexed pass). */
  folderStats(parentId: NodeId, hideUnavailable = false): FolderStats {
    const rows = this.sql.all<{ k: string; n: number; b: number | null }>(
      `SELECT json_extract(n.rec, '$.kind') AS k, count(*) AS n, sum(json_extract(n.rec, '$.content.sizeBytes')) AS b FROM nodes n
       LEFT JOIN files f ON f.node_id = n.id LEFT JOIN unavail u ON u.upload_id = f.upload_id
       WHERE n.parent_id = ? AND n.live = 1 AND (? = 0 OR u.upload_id IS NULL) GROUP BY k`,
      [parentId, hideUnavailable ? 1 : 0],
    );
    const f = rows.find((r) => r.k === "file");
    return { folders: Number(rows.find((r) => r.k === "folder")?.n ?? 0), files: Number(f?.n ?? 0), bytes: Number(f?.b ?? 0) };
  }
}

/** Keyset cursor of listChildren ([fo, key, name_key, id]); null for none or an unreadable one (start over). */
export function parseCursor(after: string | undefined): { fo: number; key: number | null; nameKey: string; id: string } | null {
  if (!after) return null;
  try {
    const a = JSON.parse(after) as unknown[];
    if (Array.isArray(a) && a.length === 4 && (a[0] === 0 || a[0] === 1) && typeof a[2] === "string" && typeof a[3] === "string")
      return { fo: a[0], key: typeof a[1] === "number" ? a[1] : null, nameKey: a[2], id: a[3] };
  } catch {
    /* fall through */
  }
  return null;
}
