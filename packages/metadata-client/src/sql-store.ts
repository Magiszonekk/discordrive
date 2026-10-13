// Tree layer on disk (koncept §4.1): one IndexStore implementation over a
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

import { nameKey, type IndexMeta, type IndexStore, type NodeId, type NodeRecord, type UploadId, type UploadRecord } from "@ddv4/sync-core";

export type SqlValue = string | number | null;

/** The few synchronous operations the store needs. */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params: SqlValue[]): { changes: number };
  get<T>(sql: string, params: SqlValue[]): T | undefined;
  all<T>(sql: string, params: SqlValue[]): T[];
  close(): void;
}

const SCHEMA_VERSION = 1;

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
}

export interface FolderStats {
  folders: number;
  files: number;
  bytes: number;
}

export class SqlIndexStore implements IndexStore {
  private depth = 0;

  constructor(readonly sql: SqlDriver) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_key TEXT NOT NULL,
        live INTEGER NOT NULL,
        rec TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_children ON nodes(parent_id, name_key, id);
      CREATE UNIQUE INDEX IF NOT EXISTS nodes_unique_name ON nodes(parent_id, name_key) WHERE live = 1 AND parent_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, rec TEXT NOT NULL);
    `);
    const ver = sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'", []);
    if (!ver) sql.run("INSERT INTO meta (k, v) VALUES ('schema', ?)", [String(SCHEMA_VERSION)]);
    else if (Number(ver.v) !== SCHEMA_VERSION) throw new Error(`index schema ${ver.v} not supported (want ${SCHEMA_VERSION}); rebuild from log`);
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
        "INSERT INTO nodes (id, parent_id, name_key, live, rec) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name_key = excluded.name_key, live = excluded.live, rec = excluded.rec",
        [rec.id, rec.parentId, nameKey(rec.name), rec.trashed === null ? 1 : 0, JSON.stringify(rec)],
      );
    } catch (e) {
      if (String((e as Error)?.message ?? e).includes("UNIQUE")) throw new Error(`unique name violation in ${rec.parentId}: ${rec.name}`);
      throw e;
    }
  }
  deleteNode(id: NodeId): void {
    this.sql.run("DELETE FROM nodes WHERE id = ?", [id]);
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
   * One page of a folder, sorted by case-folded name (then ID), keyset paging
   * (koncept §4.1: no OFFSET, only the visible rows in RAM).
   */
  listChildren(parentId: NodeId, opts: { after?: string; limit?: number; includeTrashed?: boolean } = {}): ChildRow[] {
    const [afterKey, afterId] = opts.after ? (JSON.parse(opts.after) as [string, string]) : ["", ""];
    const rows = this.sql.all<{ id: string; name_key: string; rec: string }>(
      "SELECT id, name_key, rec FROM nodes WHERE parent_id = ? AND (name_key, id) > (?, ?) AND (live = 1 OR ? = 1) ORDER BY name_key, id LIMIT ?",
      [parentId, afterKey, afterId, opts.includeTrashed ? 1 : 0, opts.limit ?? 200],
    );
    return rows.map((r) => {
      const n = JSON.parse(r.rec) as NodeRecord;
      return { id: n.id, name: n.name, kind: n.kind, size: n.content?.sizeBytes ?? null, modifiedAt: n.content?.createdAt ?? null, trashed: n.trashed !== null, cursor: JSON.stringify([r.name_key, r.id]) };
    });
  }

  countChildren(parentId: NodeId): number {
    return Number(this.sql.get<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE parent_id = ? AND live = 1", [parentId])!.n);
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
  folderStats(parentId: NodeId): FolderStats {
    const rows = this.sql.all<{ k: string; n: number; b: number | null }>(
      "SELECT json_extract(rec, '$.kind') AS k, count(*) AS n, sum(json_extract(rec, '$.content.sizeBytes')) AS b FROM nodes WHERE parent_id = ? AND live = 1 GROUP BY k",
      [parentId],
    );
    const f = rows.find((r) => r.k === "file");
    return { folders: Number(rows.find((r) => r.k === "folder")?.n ?? 0), files: Number(f?.n ?? 0), bytes: Number(f?.b ?? 0) };
  }
}
