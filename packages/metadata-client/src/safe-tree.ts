// What is inside the Safe: a tree of the sync core (the same rules as the account: names, conflicts, trash,
// the Drive and the Gallery), kept whole in the Safe's sealed state instead of a log on the instance.
//
// A change is one operation applied to the tree as the next entry of the Safe's own log (seq = head + 1, the
// device's clock as the server time: the Safe has no arbiter), then the whole state stored with the slot's
// compare-and-swap. When another device wrote meanwhile, the operation is applied again on its state with the
// base the author saw (baseSeq), so the rules decide as they do for the account (rule 1: the newer name, rule
// 4: into a trashed folder → recovered, …). Nothing of this goes through the account's log.
//
// Size: the state is one sealed object of at most 1 MiB (padded): a few thousand nodes. A larger Safe will
// need the state in parts (as the account's snapshot bases).
//
// Files' pieces: stored like any file (the account's webhooks, or the instance), referenced only from the
// Safe. When no file of the Safe uses an upload any more (purged, replaced; a failed write; a restored older
// revision) a note goes into the state (`gone`), and `cleanup()` lets the pieces go:
//  - through the instance (e2ee/plain): uploads committed outside the log are reported released (deleted
//    30 days later by the instance, as the account's files) — notes at once, any other upload the Safe does
//    not refer to after SAFE_ORPHAN_GRACE_MS (a write that never happened); released ones a restored
//    revision refers to again are kept;
//  - on the account's webhooks (metadata only): the messages of a note older than FRAGMENT_RETENTION_MS are
//    deleted by the client (device clock). Pieces of an upload interrupted before anything reached the Safe
//    stay unknown, as for an interrupted upload of the account in this mode.
// Released upload records and handled notes are then dropped from the state (it must stay small).

import {
  FRAGMENT_RETENTION_MS,
  initIndex,
  loadSnapshot,
  MemoryIndexStore,
  nameKey,
  RULES_VERSION,
  takeSnapshot,
  uploadsTouched,
  applyEntry,
  type ApplyResult,
  type ChunkManifest,
  type ContentRef,
  type DeviceInfo,
  type IndexSnapshot,
  type IndexStore,
  type LogEntry,
  type NodeId,
  type NodeRecord,
  type Operation,
} from "@ddv4/sync-core";
import { SafeStore, type UnlockedSafe } from "./safe.js";
import { decodeManifestRef, readVersionRange, type ByteSink, type ByteSource, type DownloadOptions, type DriveClient, type UploadOptions } from "./drive-client.js";
import { RateLimitedError } from "./discord-transport.js";
import type { Placement } from "./types.js";

/** An upload no file of the Safe uses any more: its pieces go (see cleanup). `at`: device time. */
export interface SafeGone {
  u: string;
  ref: string;
  at: number;
}

export interface SafeTreeState {
  v: 1;
  tree: IndexSnapshot;
  gone?: SafeGone[];
}

/** An upload committed outside the log that the Safe does not refer to this long after: a write that never happened. */
export const SAFE_ORPHAN_GRACE_MS = 60 * 60_000;

/** Where the Safe's files' pieces are, and how they are let go. */
export type SafePieces =
  | { kind: "instance"; api: { json<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> } }
  | {
      kind: "webhooks";
      client: { loadManifest(ref: string): Promise<{ manifest: ChunkManifest }>; removeBlob(p: Placement): Promise<"deleted" | "gone"> };
      sleep?: (ms: number) => Promise<void>;
    };

export interface SafeTreeOptions {
  pieces?: SafePieces;
  now?: () => number;
  tzOffsetMin?: (at: number) => number;
}

export interface SafeCleanupReport {
  safe: UnlockedSafe<SafeTreeState>;
  /** Reported released to the instance (deleted there 30 days later). */
  released: number;
  /** Released on the instance, referred to again (a restored revision): kept. */
  kept: number;
  /** Messages deleted from the account's webhooks. */
  deleted: number;
}

/** Uploads the files of a tree use, with their manifests. */
function boundRefs(t: IndexStore): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of t.allNodes()) if (n.kind === "file" && n.content) m.set(n.content.uploadId, n.content.manifestRef);
  return m;
}

const isGoneError = (e: unknown) => /404|Unknown Message|attachment missing/.test(String((e as Error)?.message ?? e));

export const emptySafeTree = (): SafeTreeState => ({ v: 1, tree: takeSnapshot(initIndex(new MemoryIndexStore())) });

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The tree of an open Safe (read-only view: a fresh store from its snapshot). */
export function safeTreeOf(u: UnlockedSafe<SafeTreeState>): IndexStore {
  if (u.state?.v !== 1) throw new Error("unsupported Safe state");
  return loadSnapshot(u.state.tree, new MemoryIndexStore());
}

/** Children of a folder of the Safe (not in the trash), folders first, by name. */
export function safeChildren(u: UnlockedSafe<SafeTreeState>, parentId: NodeId): NodeRecord[] {
  const t = safeTreeOf(u);
  return [...t.childIds(parentId)]
    .map((id) => t.getNode(id)!)
    .filter((n) => n && !n.trashed)
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : nameKey(a.name) < nameKey(b.name) ? -1 : nameKey(a.name) > nameKey(b.name) ? 1 : a.id < b.id ? -1 : 1));
}

export class SafeTree {
  private readonly now: () => number;
  private readonly tzOffsetMin: (at: number) => number;

  constructor(
    private readonly store: SafeStore<SafeTreeState>,
    private readonly device: DeviceInfo,
    private readonly o: SafeTreeOptions = {},
  ) {
    this.now = o.now ?? (() => Date.now());
    this.tzOffsetMin = o.tzOffsetMin ?? ((at) => -new Date(at).getTimezoneOffset());
  }

  /** A new Safe with an empty tree. */
  create(password: string, params?: Parameters<SafeStore<SafeTreeState>["create"]>[2]): Promise<UnlockedSafe<SafeTreeState>> {
    return this.store.create(password, emptySafeTree(), params);
  }

  /**
   * Apply one operation to the Safe's tree and store it. Returns the new open Safe and the rules' result
   * (outcome + notices) as applied to the state that was stored (after a concurrent edit: on the other's).
   */
  async commit(u: UnlockedSafe<SafeTreeState>, op: Operation): Promise<{ safe: UnlockedSafe<SafeTreeState>; result: ApplyResult }> {
    const baseSeq = u.state.tree.meta.headSeq;
    const opId = newId();
    const createdAt = this.now();
    let result: ApplyResult | null = null;
    let let_go = false;
    const safe = await this.store.update(u, (s) => {
      if (s?.v !== 1) throw new Error("unsupported Safe state");
      const t = loadSnapshot(s.tree, new MemoryIndexStore());
      const seq = t.getMeta().headSeq + 1;
      const lg = uploadsTouched(op);
      const e: LogEntry = {
        opId,
        rulesVersion: RULES_VERSION,
        baseSeq: Math.min(baseSeq, seq - 1),
        device: { ...this.device },
        createdAt,
        tzOffsetMin: this.tzOffsetMin(createdAt),
        ...(lg.length ? { leaseGuard: lg } : {}),
        op,
        seq,
        serverTime: this.now(),
      };
      const before = boundRefs(t);
      result = applyEntry(t, e);
      // Uploads this entry released (a purge, a newer version): their pieces go after the retention.
      const gone = [...(s.gone ?? [])];
      for (const up of t.allUploads()) {
        const ref = up.status === "released" && up.ended?.seq === seq ? before.get(up.id) : undefined;
        if (ref) gone.push({ u: up.id, ref, at: e.serverTime });
      }
      let_go = gone.length > (s.gone?.length ?? 0);
      return { v: 1, tree: takeSnapshot(t), ...(gone.length ? { gone } : {}) };
    });
    // The instance learns at once (best effort: the next cleanup does it otherwise).
    const after = let_go && this.o.pieces?.kind === "instance" ? await this.cleanup(safe).catch(() => null) : null;
    return { safe: after?.safe ?? safe, result: result! };
  }

  /**
   * Let go of the pieces no file of the Safe uses (see the top of this file). Run it when the Safe is open
   * (after unlocking; commit() runs it after a purge through the instance).
   */
  async cleanup(u: UnlockedSafe<SafeTreeState>): Promise<SafeCleanupReport> {
    const p = this.o.pieces;
    if (!p) throw new Error("SafeTree: no place of the pieces given");
    const cur = await this.store.unlockWithMaster(u.master);
    return p.kind === "instance" ? this.cleanupInstance(cur, p.api) : this.cleanupWebhooks(cur, p);
  }

  private async cleanupInstance(u: UnlockedSafe<SafeTreeState>, api: Extract<SafePieces, { kind: "instance" }>["api"]): Promise<SafeCleanupReport> {
    const { body } = await api.json<{ now: number; uploads: { uploadId: string; state: string; finalAt: number }[] }>("GET", "/v1/uploads/outside");
    const bound = boundRefs(safeTreeOf(u));
    const noted = new Set((u.state.gone ?? []).map((g) => g.u));
    const release = body.uploads.filter((x) => x.state === "committed" && !bound.has(x.uploadId) && (noted.has(x.uploadId) || x.finalAt <= body.now - SAFE_ORPHAN_GRACE_MS)).map((x) => x.uploadId);
    const keep = body.uploads.filter((x) => x.state === "released" && bound.has(x.uploadId)).map((x) => x.uploadId);
    for (let i = 0; i < release.length; i += 1000) await api.json("POST", "/v1/uploads/released", { uploads: release.slice(i, i + 1000).map((uploadId) => ({ uploadId, at: body.now })) });
    for (let i = 0; i < keep.length; i += 1000) await api.json("POST", "/v1/uploads/kept", { uploads: keep.slice(i, i + 1000) });
    // The instance keeps track from here: the notes seen (and their released records) leave the state. A note
    // another device adds meanwhile stays for its next run.
    const safe = noted.size ? await this.store.update(u, (s) => dropLetGo(s, noted)) : u;
    return { safe, released: release.length, kept: keep.length, deleted: 0 };
  }

  private async cleanupWebhooks(u: UnlockedSafe<SafeTreeState>, p: Extract<SafePieces, { kind: "webhooks" }>): Promise<SafeCleanupReport> {
    const now = this.now();
    const bound = boundRefs(safeTreeOf(u));
    const done = new Set<string>();
    let deleted = 0;
    for (const g of u.state.gone ?? []) {
      // In use again (a restored revision refers to it): only the note goes.
      if (bound.has(g.u)) {
        done.add(g.u);
        continue;
      }
      if (g.at + FRAGMENT_RETENTION_MS > now) continue;
      try {
        deleted += await deletePieces(p, g.ref);
        done.add(g.u);
      } catch {
        // Discord unreachable or the webhook gone from the account: the next run tries again.
      }
    }
    const safe = done.size ? await this.store.update(u, (s) => dropLetGo(s, done)) : u;
    return { safe, released: 0, kept: 0, deleted };
  }

  /** A version stored for the Safe that no file got (the write failed): noted so that its pieces go. */
  private async noteGone(u: UnlockedSafe<SafeTreeState>, v: ContentRef): Promise<void> {
    const cur = await this.store.unlockWithMaster(u.master);
    if (boundRefs(safeTreeOf(cur)).has(v.uploadId)) return;
    await this.store.update(cur, (s) => (boundRefs(loadSnapshot(s.tree, new MemoryIndexStore())).has(v.uploadId) || s.gone?.some((g) => g.u === v.uploadId) ? s : { ...s, gone: [...(s.gone ?? []), { u: v.uploadId, ref: v.manifestRef, at: this.now() }] }));
  }

  /**
   * Bring back an earlier revision (SafeStore.restore). With the Safe as it is now (`current`), the files the
   * earlier revision does not have are noted, so that their pieces go after the retention.
   */
  async restoreRevision(revision: number, unlock: { password: string } | { master: Uint8Array }, current?: UnlockedSafe<SafeTreeState>): Promise<UnlockedSafe<SafeTreeState>> {
    const r = await this.store.restore(revision, unlock);
    if (!current) return r;
    const now = boundRefs(safeTreeOf(r));
    const lost = [...boundRefs(safeTreeOf(current))].filter(([id]) => !now.has(id));
    if (!lost.length) return r;
    const at = this.now();
    return this.store.update(r, (s) => {
      const b = boundRefs(loadSnapshot(s.tree, new MemoryIndexStore()));
      const have = new Set((s.gone ?? []).map((g) => g.u));
      const add = lost.filter(([id]) => !b.has(id) && !have.has(id)).map(([id, ref]) => ({ u: id, ref, at }));
      return add.length ? { ...s, gone: [...(s.gone ?? []), ...add] } : s;
    });
  }

  /**
   * A file into the Safe: its pieces and manifest stored as any upload (the client's store: the account's
   * webhooks or the instance), its reference (with the file key) only in the Safe's state, in one Safe entry
   * (upload_begin + upload_commit + create). Nothing in the account's log.
   */
  async upload(u: UnlockedSafe<SafeTreeState>, client: DriveClient, src: ByteSource, name: string, parentId: NodeId = "root", opts: Omit<UploadOptions, "outsideLog" | "replace" | "resumeKey"> = {}): Promise<{ safe: UnlockedSafe<SafeTreeState>; nodeId: NodeId; version: ContentRef; result: ApplyResult }> {
    let out: { safe: UnlockedSafe<SafeTreeState>; result: ApplyResult } | null = null;
    let stored: ContentRef | null = null;
    const r = await client
      .upload(src, name, parentId, {
        ...opts,
        outsideLog: {
          commit: async (version, nodeId, nfc) => {
            stored = version;
            out = await this.commit(u, {
            type: "group",
            ops: [
              { type: "upload_begin", uploadId: version.uploadId },
              { type: "upload_commit", uploadId: version.uploadId },
              { type: "create", kind: "file", nodeId, parentId, name: nfc, content: version },
            ],
          });
            if (out.result.outcome !== "applied") throw new Error(`Safe: the file was not added (${out.result.outcome})`);
          },
        },
      })
      .catch(async (e: unknown) => {
        // The pieces are stored but no file of the Safe may have them: noted (best effort; through the
        // instance an unreferenced upload is let go after SAFE_ORPHAN_GRACE_MS anyway).
        if (stored) await this.noteGone(u, stored).catch(() => {});
        throw e;
      });
    return { safe: out!.safe, nodeId: r.nodeId, version: r.version, result: out!.result };
  }

  /** A file of the Safe, read with its reference from the Safe's state. */
  async download(u: UnlockedSafe<SafeTreeState>, client: DriveClient, nodeId: NodeId, sink: ByteSink, opts: Omit<DownloadOptions, "content"> = {}) {
    const n = safeTreeOf(u).getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new Error("not a file of the Safe");
    return client.download(nodeId, sink, { ...opts, content: { version: n.content, name: n.name } });
  }

  /**
   * Files of the account into the Safe. Each one is read and sent again under a new key (whoever had the
   * account key may have kept the old one, so moving its reference would protect nothing), added to the Safe,
   * then deleted for good from the account (trash + purge in one entry): its old pieces go after 30 days as
   * any purged file's. A folder brings its subtree (empty folders too). One file at a time: a failure leaves
   * what was moved in the Safe and the rest in the account (the same file never ends up in neither).
   */
  async moveIn(
    u: UnlockedSafe<SafeTreeState>,
    client: DriveClient,
    ids: NodeId[],
    safeParentId: NodeId = "root",
    o: { onProgress?: (doneBytes: number, totalBytes: number, file: string) => void; signal?: AbortSignal } = {},
  ): Promise<{ safe: UnlockedSafe<SafeTreeState>; files: number; bytes: number }> {
    await client.pull();
    const acct = client.store;
    // What goes, in order: folders before their contents; trashed nodes skipped.
    type Item = { id: NodeId; kind: "folder" | "file"; name: string; parent: NodeId | null };
    const items: Item[] = [];
    const walk = (id: NodeId, parent: NodeId | null) => {
      const n = acct.getNode(id);
      if (!n || n.trashed) return;
      if (n.kind === "folder") {
        items.push({ id, kind: "folder", name: n.name, parent });
        for (const c of acct.childIds(id)) walk(c, id);
      } else if (n.content) items.push({ id, kind: "file", name: n.name, parent });
    };
    for (const id of ids) {
      const n = acct.getNode(id);
      if (!n || n.parentId === null) throw new Error("not a file or folder of the account");
      walk(id, null);
    }
    const total = items.reduce((s, it) => s + (it.kind === "file" ? acct.getNode(it.id)!.content!.sizeBytes : 0), 0);
    const where = new Map<NodeId, NodeId>(); // account folder → Safe folder
    let safe = u;
    let done = 0;
    let files = 0;
    for (const it of items) {
      o.signal?.throwIfAborted();
      const parent = it.parent === null ? safeParentId : where.get(it.parent)!;
      if (it.kind === "folder") {
        const id = newId();
        const r = await this.commit(safe, { type: "create", kind: "folder", nodeId: id, parentId: parent, name: it.name });
        if (r.result.outcome !== "applied") throw new Error(`Safe: the folder was not added (${r.result.outcome})`);
        safe = r.safe;
        where.set(it.id, id);
        continue;
      }
      const v = acct.getNode(it.id)!.content!;
      const taken = await client.takenAt(v.manifestRef).catch(() => null);
      const up = await this.upload(safe, client, versionSource(client, v), it.name, parent, {
        signal: o.signal,
        ...(taken ? { takenAt: taken } : {}),
        onProgress: (b) => o.onProgress?.(done + b, total, it.name),
      });
      safe = up.safe;
      // In the Safe now: out of the account. Only the version that was copied (a newer one from another device
      // stays in the account: purge keeps what the author had not seen).
      await client.commitOp({ type: "group", ops: [{ type: "trash", nodeId: it.id }, { type: "purge", nodeId: it.id }] }, "move into the Safe");
      done += v.sizeBytes;
      files++;
    }
    // The folders moved, emptied of their files: out of the account too.
    const topFolders = ids.filter((id) => acct.getNode(id)?.kind === "folder");
    if (topFolders.length) await client.commitOp({ type: "group", ops: topFolders.flatMap((id) => [{ type: "trash" as const, nodeId: id }, { type: "purge" as const, nodeId: id }]) }, "move into the Safe");
    return { safe, files, bytes: done };
  }

  /**
   * Files of the Safe out to the account (`parentId` in the Drive or the Gallery): sent again under a new key
   * (the Safe's key must not end up in the account's log), added to the account, then deleted for good from the
   * Safe (its pieces go as any Safe file's). A folder brings its subtree.
   */
  async moveOut(
    u: UnlockedSafe<SafeTreeState>,
    client: DriveClient,
    ids: NodeId[],
    parentId: NodeId,
    o: { onProgress?: (doneBytes: number, totalBytes: number, file: string) => void; signal?: AbortSignal } = {},
  ): Promise<{ safe: UnlockedSafe<SafeTreeState>; files: number; bytes: number }> {
    const t = safeTreeOf(u);
    type Item = { id: NodeId; kind: "folder" | "file"; name: string; parent: NodeId | null };
    const items: Item[] = [];
    const walk = (id: NodeId, parent: NodeId | null) => {
      const n = t.getNode(id);
      if (!n || n.trashed) return;
      if (n.kind === "folder") {
        items.push({ id, kind: "folder", name: n.name, parent });
        for (const c of t.childIds(id)) walk(c, id);
      } else if (n.content) items.push({ id, kind: "file", name: n.name, parent });
    };
    for (const id of ids) {
      const n = t.getNode(id);
      if (!n || n.parentId === null) throw new Error("not a file or folder of the Safe");
      walk(id, null);
    }
    const total = items.reduce((s, it) => s + (it.kind === "file" ? t.getNode(it.id)!.content!.sizeBytes : 0), 0);
    const where = new Map<NodeId, NodeId>();
    let safe = u;
    let done = 0;
    let files = 0;
    for (const it of items) {
      o.signal?.throwIfAborted();
      const parent = it.parent === null ? parentId : where.get(it.parent)!;
      if (it.kind === "folder") {
        const id = newId();
        const r = await client.commitOp({ type: "create", kind: "folder", nodeId: id, parentId: parent, name: it.name, ...client.spaceField(parent) }, "move out of the Safe");
        if (r.outcome !== "applied") throw new Error(`the folder was not added (${r.outcome})`);
        where.set(it.id, id);
        continue;
      }
      const v = t.getNode(it.id)!.content!;
      const taken = await client.takenAt(v.manifestRef).catch(() => null);
      await client.upload(versionSource(client, v), it.name, parent, {
        signal: o.signal,
        ...(taken ? { takenAt: taken } : {}),
        onProgress: (b) => o.onProgress?.(done + b, total, it.name),
      });
      safe = (await this.commit(safe, { type: "group", ops: [{ type: "trash", nodeId: it.id }, { type: "purge", nodeId: it.id }] })).safe;
      done += v.sizeBytes;
      files++;
    }
    const topFolders = ids.filter((id) => t.getNode(id)?.kind === "folder");
    if (topFolders.length) safe = (await this.commit(safe, { type: "group", ops: topFolders.flatMap((id) => [{ type: "trash" as const, nodeId: id }, { type: "purge" as const, nodeId: id }]) })).safe;
    return { safe, files, bytes: done };
  }

  mkdir(u: UnlockedSafe<SafeTreeState>, name: string, parentId: NodeId = "root") {
    return this.commit(u, { type: "create", kind: "folder", nodeId: newId(), parentId, name: name.normalize("NFC") });
  }
  rename(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId, name: string) {
    return this.commit(u, { type: "rename", nodeId, name: name.normalize("NFC") });
  }
  move(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId, parentId: NodeId) {
    return this.commit(u, { type: "move", nodeId, parentId });
  }
  trash(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId) {
    return this.commit(u, { type: "trash", nodeId });
  }
  restore(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId) {
    return this.commit(u, { type: "restore", nodeId });
  }
}

/** The notes of `ids` and their released upload records leave the state. */
function dropLetGo(s: SafeTreeState, ids: Set<string>): SafeTreeState {
  const bound = boundRefs(loadSnapshot(s.tree, new MemoryIndexStore()));
  const gone = (s.gone ?? []).filter((g) => !ids.has(g.u));
  const uploads = s.tree.uploads.filter((r) => bound.has(r.id) || r.status === "open" || r.status === "committed" || !ids.has(r.id));
  return { v: 1, tree: { ...s.tree, uploads }, ...(gone.length ? { gone } : {}) };
}

/** Delete the messages of one version from the account's webhooks: fragments first, the manifest last. */
async function deletePieces(p: Extract<SafePieces, { kind: "webhooks" }>, ref: string): Promise<number> {
  let manifest: ChunkManifest;
  try {
    manifest = (await p.client.loadManifest(ref)).manifest;
  } catch (e) {
    // The manifest is gone: an earlier run finished the fragments already.
    if (isGoneError(e)) return 0;
    throw e;
  }
  const sleep = p.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const remove = async (pl: Placement): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await p.client.removeBlob(pl)) === "deleted";
      } catch (e) {
        if (isGoneError(e)) return false;
        if (e instanceof RateLimitedError && attempt < 8) {
          await sleep(Math.min(e.retryAfterMs, 30_000));
          continue;
        }
        throw e;
      }
    }
  };
  let n = 0;
  for (const ch of manifest.chunks) {
    const pl = (ch as { placements?: Placement[] }).placements?.[0];
    if (pl && (await remove(pl))) n++;
  }
  if (await remove(decodeManifestRef(ref).at)) n++;
  return n;
}

/** A stored version read as a source for a new upload (fragment by fragment, each checked). */
function versionSource(client: DriveClient, v: { versionId: string; sizeBytes: number; manifestRef: string }): ByteSource {
  const cache = new Map<string, Uint8Array>();
  return {
    size: v.sizeBytes,
    read: async (offset, length) => {
      if (length <= 0 || offset >= v.sizeBytes) return new Uint8Array(0);
      const r = await readVersionRange(client, v, offset, Math.min(offset + length, v.sizeBytes) - 1, cache, 2);
      // Fragments before the one read are not needed again (the upload reads in order).
      for (const k of [...cache.keys()]) if (cache.size > 4) cache.delete(k);
      return r.data;
    },
  };
}
