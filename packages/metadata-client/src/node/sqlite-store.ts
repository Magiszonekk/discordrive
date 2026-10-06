// Tree layer on disk (koncept §4.1): IndexStore on SQLite for Node (CLI/desktop).
// Uses the built-in node:sqlite (Node 22+, synchronous), so no native addon.
// The browser variant (SQLite-WASM on OPFS) implements the same schema.
//
// Schema mirrors the MemoryIndexStore contract (sync-core store.ts):
//  - records stored as JSON (the core treats them as immutable values),
//  - indexed columns for what the core and the UI query:
//      (parent_id, name_key, id) children, keyset paging for virtualized lists
//      partial UNIQUE (parent_id, name_key) WHERE live: the rule-2 uniqueness
//      guarantee is enforced by the database itself, like the memory store's throw.
//  - atomically() = one transaction (OverlayStore.commit runs inside it).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { nameKey, type IndexMeta, type IndexStore, type NodeId, type NodeRecord, type UploadId, type UploadRecord } from "@ddv4/sync-core";

const SCHEMA_VERSION = 1;

export interface ChildRow {
  id: NodeId;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  trashed: boolean;
  /** Opaque keyset cursor for the next page. */
  cursor: string;
}

export class SqliteIndexStore implements IndexStore {
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly st: Record<string, StatementSync>;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
    const ver = this.db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | undefined;
    if (!ver) this.db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    else if (Number(ver.v) !== SCHEMA_VERSION) throw new Error(`index schema ${ver.v} not supported (want ${SCHEMA_VERSION}); rebuild from log`);
    const p = (sql: string) => this.db.prepare(sql);
    this.st = {
      getMeta: p("SELECT v FROM meta WHERE k = 'index'"),
      setMeta: p("INSERT INTO meta (k, v) VALUES ('index', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      getNode: p("SELECT rec FROM nodes WHERE id = ?"),
      putNode: p(
        "INSERT INTO nodes (id, parent_id, name_key, live, rec) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name_key = excluded.name_key, live = excluded.live, rec = excluded.rec",
      ),
      deleteNode: p("DELETE FROM nodes WHERE id = ?"),
      childIds: p("SELECT id FROM nodes WHERE parent_id = ?"),
      childByKey: p("SELECT id FROM nodes WHERE parent_id = ? AND name_key = ? AND live = 1"),
      getUpload: p("SELECT rec FROM uploads WHERE id = ?"),
      putUpload: p("INSERT INTO uploads (id, rec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec"),
      allNodes: p("SELECT rec FROM nodes"),
      allUploads: p("SELECT rec FROM uploads"),
      // Row-value keyset over (name_key, id). Not a single concatenated key:
      // node:sqlite truncates TEXT at U+0000, which broke a "key\0id" cursor.
      page: p(
        "SELECT id, name_key, rec FROM nodes WHERE parent_id = ? AND (name_key, id) > (?, ?) AND (live = 1 OR ? = 1) ORDER BY name_key, id LIMIT ?",
      ),
      count: p("SELECT count(*) AS n FROM nodes WHERE parent_id = ? AND live = 1"),
    };
  }

  close(): void {
    this.db.close();
  }

  getMeta(): IndexMeta {
    const r = this.st.getMeta!.get() as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as IndexMeta) : { headSeq: 0, rulesVersion: 0 };
  }
  setMeta(meta: IndexMeta): void {
    this.st.setMeta!.run(JSON.stringify(meta));
  }

  getNode(id: NodeId): NodeRecord | undefined {
    const r = this.st.getNode!.get(id) as { rec: string } | undefined;
    return r ? (JSON.parse(r.rec) as NodeRecord) : undefined;
  }
  putNode(rec: NodeRecord): void {
    const key = nameKey(rec.name);
    try {
      this.st.putNode!.run(rec.id, rec.parentId, key, rec.trashed === null ? 1 : 0, JSON.stringify(rec));
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) throw new Error(`unique name violation in ${rec.parentId}: ${rec.name}`);
      throw e;
    }
  }
  deleteNode(id: NodeId): void {
    this.st.deleteNode!.run(id);
  }
  childIds(parentId: NodeId): Iterable<NodeId> {
    return (this.st.childIds!.all(parentId) as { id: string }[]).map((r) => r.id);
  }
  childByKey(parentId: NodeId, key: string): NodeId | undefined {
    return (this.st.childByKey!.get(parentId, key) as { id: string } | undefined)?.id;
  }

  getUpload(id: UploadId): UploadRecord | undefined {
    const r = this.st.getUpload!.get(id) as { rec: string } | undefined;
    return r ? (JSON.parse(r.rec) as UploadRecord) : undefined;
  }
  putUpload(rec: UploadRecord): void {
    this.st.putUpload!.run(rec.id, JSON.stringify(rec));
  }

  *allNodes(): Iterable<NodeRecord> {
    for (const r of this.st.allNodes!.iterate() as Iterable<{ rec: string }>) yield JSON.parse(r.rec) as NodeRecord;
  }
  *allUploads(): Iterable<UploadRecord> {
    for (const r of this.st.allUploads!.iterate() as Iterable<{ rec: string }>) yield JSON.parse(r.rec) as UploadRecord;
  }

  atomically<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
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
    const rows = this.st.page!.all(parentId, afterKey, afterId, opts.includeTrashed ? 1 : 0, opts.limit ?? 200) as {
      id: string;
      name_key: string;
      rec: string;
    }[];
    return rows.map((r) => {
      const n = JSON.parse(r.rec) as NodeRecord;
      return { id: n.id, name: n.name, kind: n.kind, size: n.content?.sizeBytes ?? null, trashed: n.trashed !== null, cursor: JSON.stringify([r.name_key, r.id]) };
    });
  }

  countChildren(parentId: NodeId): number {
    return Number((this.st.count!.get(parentId) as { n: number }).n);
  }
}
