// Index storage abstraction.
//
// The tree lives on disk on every device (SQLite on OPFS in the browser, a
// file in CLI/desktop). The core only needs this small synchronous interface;
// both better-sqlite3 (Node) and SQLite-WASM with OPFS sync access handles
// (browser worker) are synchronous, so apply() stays synchronous too.
//
// Records are treated as immutable values: apply() never mutates an object it
// got from the store, it builds a new one and calls put*. Stores may return
// shared objects.
//
// Uniqueness index: childByKey(parent, key) looks up among children that are
// NOT themselves trashed (trashed == null). In SQLite this is a partial
// unique index on (parent_id, name_key) WHERE trashed_seq IS NULL.

import { nameKey } from "./names.js";
import type { IndexMeta, NodeId, NodeRecord, UploadId, UploadRecord } from "./types.js";

export interface IndexStore {
  getMeta(): IndexMeta;
  setMeta(meta: IndexMeta): void;

  getNode(id: NodeId): NodeRecord | undefined;
  putNode(rec: NodeRecord): void;
  deleteNode(id: NodeId): void;
  /** Child IDs of a parent, in any order (all children, trashed or not). */
  childIds(parentId: NodeId): Iterable<NodeId>;
  /** Non-trashed child with the given name key. */
  childByKey(parentId: NodeId, key: string): NodeId | undefined;

  getUpload(id: UploadId): UploadRecord | undefined;
  putUpload(rec: UploadRecord): void;

  /** Full scans (snapshots, invariants). Any order. */
  allNodes(): Iterable<NodeRecord>;
  allUploads(): Iterable<UploadRecord>;

  /** Run fn atomically w.r.t. crashes (a SQLite transaction). Memory store just calls fn. */
  atomically<T>(fn: () => T): T;
}

const k2 = (parent: NodeId, key: string) => `${parent}\u0000${key}`;

export class MemoryIndexStore implements IndexStore {
  private meta: IndexMeta = { headSeq: 0, rulesVersion: 0 };
  private nodes = new Map<NodeId, NodeRecord>();
  private children = new Map<NodeId, Set<NodeId>>();
  private liveByKey = new Map<string, NodeId>();
  private uploads = new Map<UploadId, UploadRecord>();

  getMeta(): IndexMeta {
    return this.meta;
  }
  setMeta(meta: IndexMeta): void {
    this.meta = { ...meta };
  }

  getNode(id: NodeId): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  putNode(rec: NodeRecord): void {
    const prev = this.nodes.get(rec.id);
    if (prev) this.unindex(prev);
    this.nodes.set(rec.id, rec);
    this.index(rec);
  }

  deleteNode(id: NodeId): void {
    const prev = this.nodes.get(id);
    if (!prev) return;
    this.unindex(prev);
    this.nodes.delete(id);
  }

  childIds(parentId: NodeId): Iterable<NodeId> {
    return [...(this.children.get(parentId) ?? [])];
  }

  childByKey(parentId: NodeId, key: string): NodeId | undefined {
    return this.liveByKey.get(k2(parentId, key));
  }

  getUpload(id: UploadId): UploadRecord | undefined {
    return this.uploads.get(id);
  }
  putUpload(rec: UploadRecord): void {
    this.uploads.set(rec.id, rec);
  }

  allNodes(): Iterable<NodeRecord> {
    return this.nodes.values();
  }
  allUploads(): Iterable<UploadRecord> {
    return this.uploads.values();
  }

  atomically<T>(fn: () => T): T {
    return fn();
  }

  private index(rec: NodeRecord): void {
    if (rec.parentId === null) return;
    let set = this.children.get(rec.parentId);
    if (!set) this.children.set(rec.parentId, (set = new Set()));
    set.add(rec.id);
    if (rec.trashed === null) {
      const key = k2(rec.parentId, nameKey(rec.name));
      const other = this.liveByKey.get(key);
      if (other !== undefined && other !== rec.id) {
        // Mirrors the SQLite partial unique index: a bug in apply() must fail loudly.
        throw new Error(`unique name violation in ${rec.parentId}: ${rec.name}`);
      }
      this.liveByKey.set(key, rec.id);
    }
  }

  private unindex(rec: NodeRecord): void {
    if (rec.parentId === null) return;
    this.children.get(rec.parentId)?.delete(rec.id);
    if (rec.trashed === null) {
      const key = k2(rec.parentId, nameKey(rec.name));
      if (this.liveByKey.get(key) === rec.id) this.liveByKey.delete(key);
    }
  }
}

/**
 * Write buffer over another store. apply() runs every log entry inside an
 * overlay and commits only if the whole entry succeeded, which gives
 * all-or-nothing group operations and no half-applied single ops.
 */
export class OverlayStore implements IndexStore {
  private meta: IndexMeta | null = null;
  /** null = deleted in this overlay. */
  private nodes = new Map<NodeId, NodeRecord | null>();
  private liveByKey = new Map<string, NodeId>();
  private uploads = new Map<UploadId, UploadRecord>();

  constructor(private readonly base: IndexStore) {}

  getMeta(): IndexMeta {
    return this.meta ?? this.base.getMeta();
  }
  setMeta(meta: IndexMeta): void {
    this.meta = { ...meta };
  }

  getNode(id: NodeId): NodeRecord | undefined {
    if (this.nodes.has(id)) return this.nodes.get(id) ?? undefined;
    return this.base.getNode(id);
  }

  putNode(rec: NodeRecord): void {
    this.unindexOverlay(rec.id);
    this.nodes.set(rec.id, rec);
    if (rec.parentId !== null && rec.trashed === null) {
      const key = k2(rec.parentId, nameKey(rec.name));
      const other = this.childByKey(rec.parentId, nameKey(rec.name));
      if (other !== undefined && other !== rec.id) {
        throw new Error(`unique name violation in ${rec.parentId}: ${rec.name}`);
      }
      this.liveByKey.set(key, rec.id);
    }
  }

  deleteNode(id: NodeId): void {
    this.unindexOverlay(id);
    this.nodes.set(id, null);
  }

  childIds(parentId: NodeId): Iterable<NodeId> {
    const out: NodeId[] = [];
    for (const id of this.base.childIds(parentId)) {
      if (!this.nodes.has(id)) out.push(id);
    }
    for (const [id, rec] of this.nodes) {
      if (rec && rec.parentId === parentId) out.push(id);
    }
    return out;
  }

  childByKey(parentId: NodeId, key: string): NodeId | undefined {
    const mine = this.liveByKey.get(k2(parentId, key));
    if (mine !== undefined) return mine;
    const baseId = this.base.childByKey(parentId, key);
    // A node changed in this overlay is only found through liveByKey.
    if (baseId === undefined || this.nodes.has(baseId)) return undefined;
    return baseId;
  }

  getUpload(id: UploadId): UploadRecord | undefined {
    return this.uploads.get(id) ?? this.base.getUpload(id);
  }
  putUpload(rec: UploadRecord): void {
    this.uploads.set(rec.id, rec);
  }

  *allNodes(): Iterable<NodeRecord> {
    for (const rec of this.base.allNodes()) if (!this.nodes.has(rec.id)) yield rec;
    for (const rec of this.nodes.values()) if (rec) yield rec;
  }
  *allUploads(): Iterable<UploadRecord> {
    for (const rec of this.base.allUploads()) if (!this.uploads.has(rec.id)) yield rec;
    yield* this.uploads.values();
  }

  atomically<T>(fn: () => T): T {
    return fn();
  }

  get changedNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Write everything to the base store in one transaction. Changed nodes are
   * removed first and re-inserted after, so intermediate states never trip
   * the unique-name index (e.g. two nodes swapping names inside a group).
   */
  commit(): void {
    this.base.atomically(() => {
      for (const id of this.nodes.keys()) this.base.deleteNode(id);
      for (const rec of this.nodes.values()) if (rec) this.base.putNode(rec);
      for (const rec of this.uploads.values()) this.base.putUpload(rec);
      if (this.meta) this.base.setMeta(this.meta);
    });
  }

  private unindexOverlay(id: NodeId): void {
    const prev = this.nodes.get(id);
    if (prev && prev.parentId !== null && prev.trashed === null) {
      const key = k2(prev.parentId, nameKey(prev.name));
      if (this.liveByKey.get(key) === id) this.liveByKey.delete(key);
    }
  }
}
