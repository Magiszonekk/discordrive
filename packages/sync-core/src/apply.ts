// Deterministic application of log entries to the index (koncept §5).
//
// Contract:
//  - The result depends only on the current state and the entry (§5.2.2). No
//    clocks, no randomness, no locale, no engine-dependent Unicode tables.
//    Iteration over children is always sorted by ID.
//  - Order comes only from entry.seq assigned by the server (§5.2.1).
//  - A malformed or semantically invalid operation is never an exception: it
//    is consumed as a deterministic no-op ("rejected") with a notice, so one
//    bad client cannot stall every replica. Exceptions mean a bug in the core
//    (or a log gap / unsupported rules version).
//  - Each entry is applied in a write overlay and committed atomically. A
//    group op is all-or-nothing: if any sub-op is skipped or rejected, the
//    whole group is rolled back (§4).

import {
  conflictName,
  nameKey,
  suffixedName,
  validateName,
} from "./names.js";
import { OverlayStore, type IndexStore } from "./store.js";
import {
  MIN_REPLAY_RULES_VERSION,
  RECOVERED_ID,
  ROOT_ID,
  RULES_VERSION,
  SYSTEM_IDS,
  type ChangeMark,
  type ContentRef,
  type CreateOp,
  type FileVersion,
  type LogEntry,
  type MoveOp,
  type NewContentVersionOp,
  type NodeId,
  type NodeKind,
  type NodeRecord,
  type Operation,
  type PurgeOp,
  type RenameOp,
  type RestoreOp,
  type SingleOp,
  type TrashOp,
  type UploadAbortOp,
  type UploadBeginOp,
  type UploadCommitOp,
  type UploadRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Results and notices

export type NoticeCode =
  /** Rule 1: rename replaced a name change the author had not seen. */
  | "rename_overrode_unseen"
  /** Rule 2: name taken, node got a `(n)` suffix. */
  | "name_suffixed"
  /** Rule 3: new content brought a file back from the trash. */
  | "restored_by_new_content"
  /** Rule 3b: new content for a purged file, stored as a new file in „Odzyskane”. */
  | "content_for_purged_file"
  /** Rules 3b/4 etc.: node placed in „Odzyskane” instead of its target. */
  | "moved_to_recovered"
  /** Rule 3b: rename/move/trash/restore on a purged (unknown) node. */
  | "node_purged"
  /** Rule 5: move into a folder in the trash, skipped. */
  | "move_target_in_trash"
  /** Rule 5 variant: move into a purged folder, skipped. */
  | "move_target_purged"
  /** Rule 6: move would create a cycle, skipped. */
  | "move_cycle"
  /** Rule 7: two content versions, the earlier one kept as a visible copy. */
  | "content_conflict"
  /** Rule 8: commit after abort. The client must start the upload over and clean up. */
  | "upload_aborted"
  /** Purge of a node that is not in the trash (e.g. restored meanwhile), skipped. */
  | "purge_not_in_trash"
  /** Purge skipped: the subtree has content/placements the author had not seen (§5.2.3). */
  | "purge_skipped_unseen_changes"
  /** Trash of a file skipped: it has new content the author had not seen (§5.2.3). */
  | "trash_skipped_unseen_content"
  /** Group op rolled back because a sub-op was skipped or rejected. */
  | "group_rolled_back"
  /** Invalid operation (client bug or malicious client), consumed as no-op. */
  | "invalid_op";

export interface Notice {
  seq: number;
  opId: string;
  /** Author of the operation. */
  deviceId: string;
  code: NoticeCode;
  nodeId?: NodeId;
  /** e.g. the conflict copy or the new node in „Odzyskane”. */
  relatedNodeId?: NodeId;
  reason?: string;
  /** For moved_to_recovered: path of the intended target (names from its root). */
  targetPath?: string[] | null;
}

export type Outcome =
  /** State changed as the operation (possibly transformed by a rule) says. */
  | "applied"
  /** Valid, but nothing to do (already in that state). */
  | "noop"
  /** Valid, but a conflict rule says not to apply it (rules 3b, 5, 6, purge of a restored node). */
  | "skipped"
  /** Invalid operation. */
  | "rejected"
  /** Entry already applied earlier (seq <= headSeq). */
  | "already_applied";

export interface ApplyResult {
  seq: number;
  opId: string;
  outcome: Outcome;
  notices: Notice[];
}

export class UnsupportedRulesVersionError extends Error {
  constructor(
    readonly seq: number,
    readonly rulesVersion: number,
  ) {
    super(
      `log entry ${seq} uses rules version ${rulesVersion}; this build supports ${MIN_REPLAY_RULES_VERSION}..${RULES_VERSION}. Update the client.`,
    );
    this.name = "UnsupportedRulesVersionError";
  }
}

export class LogGapError extends Error {
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(`log gap: expected seq ${expected}, got ${got}`);
    this.name = "LogGapError";
  }
}

// ---------------------------------------------------------------------------
// Index creation

const SYSTEM_MARK: ChangeMark = { seq: 0, deviceId: "system" };

function systemNode(id: NodeId, name: string): NodeRecord {
  return {
    id,
    kind: "folder",
    name,
    parentId: null,
    trashed: null,
    created: SYSTEM_MARK,
    nameChanged: SYSTEM_MARK,
    placed: SYSTEM_MARK,
    content: null,
    recoveredFrom: null,
    conflictOf: null,
  };
}

/** Put the system roots into an empty store. Idempotent. */
export function initIndex(store: IndexStore): IndexStore {
  if (!store.getNode(ROOT_ID)) store.putNode(systemNode(ROOT_ID, ""));
  if (!store.getNode(RECOVERED_ID)) store.putNode(systemNode(RECOVERED_ID, "Odzyskane"));
  return store;
}

// ---------------------------------------------------------------------------
// Entry application

export function applyEntries(store: IndexStore, entries: Iterable<LogEntry>): ApplyResult[] {
  const out: ApplyResult[] = [];
  for (const e of entries) out.push(applyEntry(store, e));
  return out;
}

export function applyEntry(store: IndexStore, entry: LogEntry): ApplyResult {
  const meta = store.getMeta();
  if (entry.seq <= meta.headSeq) {
    return { seq: entry.seq, opId: entry.opId, outcome: "already_applied", notices: [] };
  }
  if (entry.seq !== meta.headSeq + 1) throw new LogGapError(meta.headSeq + 1, entry.seq);
  if (
    !Number.isInteger(entry.rulesVersion) ||
    entry.rulesVersion < MIN_REPLAY_RULES_VERSION ||
    entry.rulesVersion > RULES_VERSION
  ) {
    throw new UnsupportedRulesVersionError(entry.seq, entry.rulesVersion);
  }
  // Only rules version 1 exists. A future version dispatches here on
  // entry.rulesVersion, so old entries keep replaying with their own rules.

  const ov = new OverlayStore(store);
  const ctx = new Ctx(ov, entry);
  let outcome: Outcome;
  const envErr = validateEnvelope(entry);
  if (envErr) {
    ctx.notice({ code: "invalid_op", reason: envErr });
    outcome = "rejected";
  } else if (entry.op.type === "group") {
    outcome = applyGroup(ctx, entry.op.ops);
  } else {
    outcome = applySingle(ctx, entry.op, 0);
  }

  const ok = outcome === "applied" || outcome === "noop";
  const target = ok ? ov : new OverlayStore(store);
  target.setMeta({ headSeq: entry.seq, rulesVersion: Math.max(meta.rulesVersion, entry.rulesVersion) });
  target.commit();
  return { seq: entry.seq, opId: entry.opId, outcome, notices: ctx.notices };
}

function applyGroup(ctx: Ctx, ops: unknown): Outcome {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100_000) {
    ctx.notice({ code: "invalid_op", reason: "bad_group" });
    return "rejected";
  }
  let any = false;
  for (let i = 0; i < ops.length; i++) {
    const sub = ops[i] as SingleOp;
    if (!sub || typeof sub !== "object" || (sub as { type?: unknown }).type === "group") {
      ctx.notice({ code: "invalid_op", reason: "bad_group_member" });
      ctx.notice({ code: "group_rolled_back", reason: `sub_${i}` });
      return "rejected";
    }
    const r = applySingle(ctx, sub, i);
    if (r === "skipped" || r === "rejected") {
      ctx.notice({ code: "group_rolled_back", reason: `sub_${i}` });
      return r;
    }
    if (r === "applied") any = true;
  }
  return any ? "applied" : "noop";
}

function applySingle(ctx: Ctx, op: SingleOp, sub: number): Outcome {
  ctx.sub = sub;
  switch (op.type) {
    case "create":
      return opCreate(ctx, op);
    case "rename":
      return opRename(ctx, op);
    case "move":
      return opMove(ctx, op);
    case "trash":
      return opTrash(ctx, op);
    case "restore":
      return opRestore(ctx, op);
    case "purge":
      return opPurge(ctx, op);
    case "new_content_version":
      return opNewContent(ctx, op);
    case "upload_begin":
      return opUploadBegin(ctx, op);
    case "upload_commit":
      return opUploadCommit(ctx, op);
    case "upload_abort":
      return opUploadAbort(ctx, op);
    default:
      ctx.notice({ code: "invalid_op", reason: "unknown_type" });
      return "rejected";
  }
}

// ---------------------------------------------------------------------------
// Context and helpers

class Ctx {
  notices: Notice[] = [];
  sub = 0;
  constructor(
    readonly s: IndexStore,
    readonly e: LogEntry,
  ) {}

  get mark(): ChangeMark {
    return { seq: this.e.seq, deviceId: this.e.device.id };
  }

  /** Did the author of this entry not know about a change marked `m`? Own earlier ops are always known. */
  unseen(m: ChangeMark): boolean {
    return m.seq > this.e.baseSeq && m.deviceId !== this.e.device.id;
  }

  /** Deterministic ID for nodes created by rules (conflict copies, recovered content). Unique: seq is. */
  derivedId(tag: string): NodeId {
    return `d:${this.e.seq}:${this.sub}:${tag}`;
  }

  notice(n: Omit<Notice, "seq" | "opId" | "deviceId">): void {
    this.notices.push({ seq: this.e.seq, opId: this.e.opId, deviceId: this.e.device.id, ...n });
  }

  reject(reason: string, nodeId?: NodeId): Outcome {
    this.notice({ code: "invalid_op", reason, ...(nodeId !== undefined ? { nodeId } : {}) });
    return "rejected";
  }

  /** Rule 8: an op touching an upload must declare it, so the server could check the lease. */
  guarded(uploadId: string): boolean {
    const g = this.e.leaseGuard;
    return Array.isArray(g) && g.includes(uploadId);
  }
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** IDs a client may mint (nodes, uploads, versions, ops). Derived IDs use ':' so they never collide. */
export function isClientId(v: unknown): v is string {
  return typeof v === "string" && CLIENT_ID_RE.test(v) && !SYSTEM_IDS.has(v);
}
function isRef(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 512;
}

function validateEnvelope(e: LogEntry): string | null {
  if (!isClientId(e.opId)) return "bad_op_id";
  if (!Number.isInteger(e.baseSeq) || e.baseSeq < 0 || e.baseSeq >= e.seq) return "bad_base_seq";
  if (!e.device || typeof e.device !== "object" || !isRef(e.device.id) || typeof e.device.name !== "string") {
    return "bad_device";
  }
  if (typeof e.createdAt !== "number" || !Number.isFinite(e.createdAt)) return "bad_created_at";
  if (e.leaseGuard !== undefined && (!Array.isArray(e.leaseGuard) || !e.leaseGuard.every(isClientId))) {
    return "bad_lease_guard";
  }
  if (!e.op || typeof e.op !== "object") return "bad_op";
  return null;
}

function validateContent(c: unknown): string | null {
  if (!c || typeof c !== "object") return "content_missing";
  const x = c as ContentRef;
  if (!isClientId(x.versionId)) return "bad_version_id";
  if (!isClientId(x.uploadId)) return "bad_upload_id";
  if (!Number.isSafeInteger(x.sizeBytes) || x.sizeBytes < 0) return "bad_size";
  if (!Number.isSafeInteger(x.chunkCount) || x.chunkCount < 0) return "bad_chunk_count";
  if (!isRef(x.manifestRef)) return "bad_manifest_ref";
  return null;
}

/** Copy only known fields: payloads come from other clients and are replicated as-is. */
function toVersion(ctx: Ctx, c: ContentRef): FileVersion {
  return {
    versionId: c.versionId,
    uploadId: c.uploadId,
    sizeBytes: c.sizeBytes,
    manifestRef: c.manifestRef,
    chunkCount: c.chunkCount,
    device: { id: ctx.e.device.id, name: ctx.e.device.name },
    createdAt: ctx.e.createdAt,
    seq: ctx.e.seq,
  };
}

/** Node or an ancestor is trashed. Missing/looping chain counts as trash (defensive; cannot happen). */
export function inTrash(s: IndexStore, id: NodeId): boolean {
  let cur = s.getNode(id);
  for (let guard = 0; cur; guard++) {
    if (cur.trashed) return true;
    if (cur.parentId === null) return false;
    if (guard > 1_000_000) return true;
    cur = s.getNode(cur.parentId);
  }
  return true;
}

/** Is `ancestor` on the parent chain of `id` (or equal to it)? */
function isSelfOrAncestor(s: IndexStore, ancestor: NodeId, id: NodeId): boolean {
  let cur: NodeId | null = id;
  for (let guard = 0; cur !== null && guard < 1_000_000; guard++) {
    if (cur === ancestor) return true;
    cur = s.getNode(cur)?.parentId ?? null;
  }
  return false;
}

/** Names from the root (root excluded) down to `id`, inclusive. */
export function pathOf(s: IndexStore, id: NodeId): string[] | null {
  const out: string[] = [];
  let cur = s.getNode(id);
  for (let guard = 0; cur && guard < 1_000_000; guard++) {
    if (cur.parentId === null) {
      if (cur.id === RECOVERED_ID) out.push(cur.name);
      return out.reverse();
    }
    out.push(cur.name);
    cur = s.getNode(cur.parentId);
  }
  return null;
}

function sortedChildren(s: IndexStore, parentId: NodeId): NodeId[] {
  return [...s.childIds(parentId)].sort(cmp);
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rule 2: first free `name`, `name (2)`, `name (3)`, ... among non-trashed children. */
function freeName(s: IndexStore, parentId: NodeId, name: string, kind: NodeKind, selfId: NodeId): string {
  const taken = (n: string) => {
    const other = s.childByKey(parentId, nameKey(n));
    return other !== undefined && other !== selfId;
  };
  if (!taken(name)) return name;
  for (let i = 2; ; i++) {
    const cand = suffixedName(name, kind, i);
    if (!taken(cand)) return cand;
  }
}

/**
 * Put a (non-trashed) node under parentId with a free name. Emits the rule-2
 * notice. Returns the stored record.
 */
function placeLive(ctx: Ctx, rec: NodeRecord, parentId: NodeId, wantedName: string): NodeRecord {
  const name = freeName(ctx.s, parentId, wantedName, rec.kind, rec.id);
  if (name !== wantedName) ctx.notice({ code: "name_suffixed", nodeId: rec.id, reason: wantedName });
  const nameChanged = name !== rec.name ? ctx.mark : rec.nameChanged;
  const out: NodeRecord = { ...rec, parentId, name, trashed: null, nameChanged };
  ctx.s.putNode(out);
  return out;
}

/** Put a node into „Odzyskane” (rules 3, 3b, 4), live, with the intended target recorded. */
function placeRecovered(
  ctx: Ctx,
  rec: NodeRecord,
  intendedParentId: NodeId | null,
  reason: string,
): NodeRecord {
  const targetPath = intendedParentId === null ? null : pathOf(ctx.s, intendedParentId);
  const base: NodeRecord = {
    ...rec,
    placed: ctx.mark,
    recoveredFrom: { parentId: intendedParentId, path: targetPath, seq: ctx.e.seq },
  };
  const out = placeLive(ctx, base, RECOVERED_ID, rec.name);
  ctx.notice({ code: "moved_to_recovered", nodeId: rec.id, reason, targetPath });
  return out;
}

function bindUpload(ctx: Ctx, uploadId: string, nodeId: NodeId, versionId: string): void {
  const u = ctx.s.getUpload(uploadId)!;
  ctx.s.putUpload({
    ...u,
    status: "bound",
    boundTo: { nodeId, versionId, seq: ctx.e.seq, deviceId: ctx.e.device.id },
  });
}

function releaseUpload(ctx: Ctx, uploadId: string, reason: "purged" | "superseded"): void {
  const u = ctx.s.getUpload(uploadId);
  if (!u) throw new Error(`bug: version references unknown upload ${uploadId}`);
  ctx.s.putUpload({
    ...u,
    status: "released",
    ended: { seq: ctx.e.seq, at: ctx.e.serverTime, reason, opId: ctx.e.opId },
  });
}

/** Upload usable as content: declared in leaseGuard, committed and not referenced yet (rule 8). */
function checkUploadUsable(ctx: Ctx, uploadId: string): string | null {
  if (!ctx.guarded(uploadId)) return "upload_not_guarded";
  const u = ctx.s.getUpload(uploadId);
  if (!u) return "upload_unknown";
  if (u.status === "aborted") return "upload_aborted";
  if (u.status === "open") return "upload_not_committed";
  if (u.status !== "committed") return "upload_already_used";
  return null;
}

// ---------------------------------------------------------------------------
// Operations

function opCreate(ctx: Ctx, op: CreateOp): Outcome {
  if (!isClientId(op.nodeId)) return ctx.reject("bad_node_id");
  if (ctx.s.getNode(op.nodeId)) return ctx.reject("node_exists", op.nodeId);
  if (op.kind !== "file" && op.kind !== "folder") return ctx.reject("bad_kind", op.nodeId);
  const nameErr = validateName(op.name);
  if (nameErr) return ctx.reject(nameErr, op.nodeId);
  if (!isRef(op.parentId)) return ctx.reject("bad_parent_id", op.nodeId);

  let content: FileVersion | null = null;
  if (op.kind === "file") {
    const cErr = validateContent(op.content) ?? checkUploadUsable(ctx, op.content!.uploadId);
    if (cErr) return ctx.reject(cErr, op.nodeId);
    content = toVersion(ctx, op.content!);
  } else if (op.content !== undefined) {
    return ctx.reject("folder_with_content", op.nodeId);
  }

  const rec: NodeRecord = {
    id: op.nodeId,
    kind: op.kind,
    name: op.name,
    parentId: null,
    trashed: null,
    created: ctx.mark,
    nameChanged: ctx.mark,
    placed: ctx.mark,
    content,
    recoveredFrom: null,
    conflictOf: null,
  };

  const parent = ctx.s.getNode(op.parentId);
  if (parent && parent.kind !== "folder") return ctx.reject("parent_not_folder", op.nodeId);
  if (!parent) {
    // Rule 4 with a purged target folder (unknown ID = purged, rule 3b).
    placeRecovered(ctx, rec, op.parentId, "parent_purged");
  } else if (inTrash(ctx.s, op.parentId)) {
    // Rule 4: added to a deleted folder.
    placeRecovered(ctx, rec, op.parentId, "parent_in_trash");
  } else {
    placeLive(ctx, rec, op.parentId, op.name);
  }
  if (content) bindUpload(ctx, content.uploadId, rec.id, content.versionId);
  return "applied";
}

function opRename(ctx: Ctx, op: RenameOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  const nameErr = validateName(op.name);
  if (nameErr) return ctx.reject(nameErr, op.nodeId);
  const node = ctx.s.getNode(op.nodeId);
  if (!node) {
    // Rule 3b: metadata changes for a purged node are dropped.
    ctx.notice({ code: "node_purged", nodeId: op.nodeId, reason: "rename" });
    return "skipped";
  }
  if (node.name === op.name) return "noop";
  // Rule 1: the later rename wins; tell if the author had not seen the previous one.
  if (ctx.unseen(node.nameChanged)) {
    ctx.notice({ code: "rename_overrode_unseen", nodeId: node.id, reason: node.name });
  }
  if (node.trashed) {
    // Rule 3: applied, stays in the trash. Trashed nodes are outside the
    // uniqueness scope; collisions are resolved on restore.
    ctx.s.putNode({ ...node, name: op.name, nameChanged: ctx.mark });
  } else {
    placeLive(ctx, { ...node, nameChanged: ctx.mark }, node.parentId!, op.name);
  }
  return "applied";
}

function opMove(ctx: Ctx, op: MoveOp): Outcome {
  if (!isRef(op.nodeId) || !isRef(op.parentId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  const node = ctx.s.getNode(op.nodeId);
  if (!node) {
    ctx.notice({ code: "node_purged", nodeId: op.nodeId, reason: "move" });
    return "skipped";
  }
  const target = ctx.s.getNode(op.parentId);
  if (!target) {
    ctx.notice({ code: "move_target_purged", nodeId: node.id, reason: op.parentId });
    return "skipped";
  }
  if (target.kind !== "folder") return ctx.reject("target_not_folder", node.id);
  if (node.parentId === op.parentId) return "noop";
  if (inTrash(ctx.s, op.parentId)) {
    // Rule 5.
    ctx.notice({ code: "move_target_in_trash", nodeId: node.id, reason: op.parentId });
    return "skipped";
  }
  if (isSelfOrAncestor(ctx.s, node.id, op.parentId)) {
    // Rule 6: the earlier move already applied; this one would close a cycle.
    ctx.notice({ code: "move_cycle", nodeId: node.id, reason: op.parentId });
    return "skipped";
  }
  const moved: NodeRecord = { ...node, placed: ctx.mark, recoveredFrom: null };
  if (node.trashed) {
    // Rule 3: applied, stays in the trash.
    ctx.s.putNode({ ...moved, parentId: op.parentId });
  } else {
    // Also covers rule 4, second sentence: an explicit move out of a trashed
    // folder brings the node back (explicit beats indirect deletion).
    placeLive(ctx, moved, op.parentId, node.name);
  }
  return "applied";
}

function opTrash(ctx: Ctx, op: TrashOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  const node = ctx.s.getNode(op.nodeId);
  if (!node) {
    ctx.notice({ code: "node_purged", nodeId: op.nodeId, reason: "trash" });
    return "skipped";
  }
  if (node.trashed) return "noop";
  if (node.content && ctx.unseen({ seq: node.content.seq, deviceId: node.content.device.id })) {
    // §5.2.3 + rule 3 in the other order: new content the author has not
    // seen keeps the file alive (with rule 3's order the file would come back
    // from the trash anyway). PROVISIONAL, see QUESTIONS.md Q2.
    ctx.notice({ code: "trash_skipped_unseen_content", nodeId: node.id });
    return "skipped";
  }
  ctx.s.putNode({ ...node, trashed: { seq: ctx.e.seq, at: ctx.e.serverTime } });
  if (node.kind === "folder") rescueUnseen(ctx, node.id);
  return "applied";
}

/**
 * Rule 4, other order: nodes placed into the folder's subtree by operations
 * the trashing author had not seen go to „Odzyskane” instead of the trash.
 * (With the plain order the rule applies in opCreate.) The same holds for
 * files whose content changed unseen (§5.2.3: new content never silently
 * ends up in the trash; rule 3 in the other order).
 */
function rescueUnseen(ctx: Ctx, folderId: NodeId): void {
  const stack: NodeId[] = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const kids = sortedChildren(ctx.s, id);
    // Process in ascending ID order: push reversed so pop yields ascending.
    const descend: NodeId[] = [];
    for (const kid of kids) {
      const rec = ctx.s.getNode(kid)!;
      if (rec.trashed) continue;
      const unseenContent =
        rec.content !== null && ctx.unseen({ seq: rec.content.seq, deviceId: rec.content.device.id });
      if (ctx.unseen(rec.placed) || unseenContent) {
        placeRecovered(ctx, rec, rec.parentId, unseenContent ? "content_changed_in_deleted_folder" : "added_to_deleted_folder");
      } else if (rec.kind === "folder") {
        descend.push(kid);
      }
    }
    for (let i = descend.length - 1; i >= 0; i--) stack.push(descend[i]!);
  }
}

function opRestore(ctx: Ctx, op: RestoreOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  const node = ctx.s.getNode(op.nodeId);
  if (!node) {
    ctx.notice({ code: "node_purged", nodeId: op.nodeId, reason: "restore" });
    return "skipped";
  }
  if (!inTrash(ctx.s, node.id)) return "noop";
  const parentId = node.parentId!;
  const restored: NodeRecord = { ...node, trashed: null, placed: ctx.mark };
  if (node.trashed && !inTrash(ctx.s, parentId)) {
    placeLive(ctx, restored, parentId, node.name);
  } else {
    // Parent (or the node's own ancestor) is still in the trash.
    placeRecovered(ctx, restored, parentId, "restore_parent_in_trash");
  }
  return "applied";
}

function opPurge(ctx: Ctx, op: PurgeOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  const node = ctx.s.getNode(op.nodeId);
  if (!node) return "noop";
  if (!inTrash(ctx.s, node.id)) {
    ctx.notice({ code: "purge_not_in_trash", nodeId: node.id });
    return "skipped";
  }
  // Whole subtree, deterministic order.
  const all: NodeId[] = [];
  const stack = [node.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    all.push(id);
    for (const kid of sortedChildren(ctx.s, id)) stack.push(kid);
  }
  all.sort(cmp);
  // §5.2.3: never physically forget content or placements the purging author
  // has not seen. PROVISIONAL, see QUESTIONS.md Q3.
  for (const id of all) {
    const rec = ctx.s.getNode(id)!;
    const unseen =
      ctx.unseen(rec.placed) || (rec.content !== null && ctx.unseen({ seq: rec.content.seq, deviceId: rec.content.device.id }));
    if (unseen) {
      ctx.notice({ code: "purge_skipped_unseen_changes", nodeId: node.id, relatedNodeId: id });
      return "skipped";
    }
  }
  for (const id of all) {
    const rec = ctx.s.getNode(id)!;
    if (rec.content) releaseUpload(ctx, rec.content.uploadId, "purged");
    ctx.s.deleteNode(id);
  }
  return "applied";
}

function opNewContent(ctx: Ctx, op: NewContentVersionOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  if (op.baseVersionId !== null && !isRef(op.baseVersionId)) return ctx.reject("bad_base_version", op.nodeId);
  const cErr = validateContent(op.content) ?? checkUploadUsable(ctx, op.content.uploadId);
  if (cErr) return ctx.reject(cErr, op.nodeId);
  const version = toVersion(ctx, op.content);

  const node = ctx.s.getNode(op.nodeId);
  if (!node) {
    // Rule 3b: purged file. Metadata is gone; the content becomes a new file in „Odzyskane”.
    const hint = typeof op.nameHint === "string" && validateName(op.nameHint) === null ? op.nameHint : "plik";
    const id = ctx.derivedId("recovered");
    const rec: NodeRecord = {
      id,
      kind: "file",
      name: hint,
      parentId: null,
      trashed: null,
      created: ctx.mark,
      nameChanged: ctx.mark,
      placed: ctx.mark,
      content: version,
      recoveredFrom: null,
      conflictOf: null,
    };
    placeRecovered(ctx, rec, null, "content_for_purged_file");
    ctx.notice({ code: "content_for_purged_file", nodeId: op.nodeId, relatedNodeId: id });
    bindUpload(ctx, version.uploadId, id, version.versionId);
    return "applied";
  }
  if (node.kind !== "file") return ctx.reject("not_a_file", node.id);

  // Rule 3: new content brings the file back from the trash.
  let rec = node;
  if (inTrash(ctx.s, node.id)) {
    const parentId = node.parentId!;
    const back: NodeRecord = { ...node, trashed: null, placed: ctx.mark };
    if (node.trashed && !inTrash(ctx.s, parentId)) {
      rec = placeLive(ctx, back, parentId, node.name);
    } else {
      rec = placeRecovered(ctx, back, parentId, "new_content_in_trash");
    }
    ctx.notice({ code: "restored_by_new_content", nodeId: node.id });
  }

  const cur = rec.content;
  if (cur && cur.versionId !== op.baseVersionId) {
    // Rule 7: the later version is current; the earlier one stays as a visible copy.
    const copyId = ctx.derivedId("conflict");
    const copy: NodeRecord = {
      id: copyId,
      kind: "file",
      name: conflictName(rec.name, cur.device.name, cur.createdAt),
      parentId: null,
      trashed: null,
      created: ctx.mark,
      nameChanged: ctx.mark,
      placed: ctx.mark,
      content: cur,
      recoveredFrom: null,
      conflictOf: { nodeId: rec.id, seq: ctx.e.seq },
    };
    ctx.s.putNode({ ...rec, content: version });
    placeLive(ctx, copy, rec.parentId!, copy.name);
    bindUpload(ctx, cur.uploadId, copyId, cur.versionId);
    ctx.notice({ code: "content_conflict", nodeId: rec.id, relatedNodeId: copyId });
  } else {
    if (cur) releaseUpload(ctx, cur.uploadId, "superseded");
    ctx.s.putNode({ ...rec, content: version });
  }
  bindUpload(ctx, version.uploadId, rec.id, version.versionId);
  return "applied";
}

function opUploadBegin(ctx: Ctx, op: UploadBeginOp): Outcome {
  if (!isClientId(op.uploadId)) return ctx.reject("bad_upload_id");
  if (!ctx.guarded(op.uploadId)) return ctx.reject("upload_not_guarded");
  if (ctx.s.getUpload(op.uploadId)) return ctx.reject("upload_exists");
  const rec: UploadRecord = { id: op.uploadId, status: "open", began: ctx.mark, boundTo: null, ended: null };
  ctx.s.putUpload(rec);
  return "applied";
}

function opUploadCommit(ctx: Ctx, op: UploadCommitOp): Outcome {
  if (!isClientId(op.uploadId)) return ctx.reject("bad_upload_id");
  if (!ctx.guarded(op.uploadId)) return ctx.reject("upload_not_guarded");
  const u = ctx.s.getUpload(op.uploadId);
  if (!u) return ctx.reject("upload_unknown");
  if (u.status === "aborted") {
    // Rule 8: commit after abort is refused; the client starts over and deletes its leftovers.
    ctx.notice({ code: "upload_aborted", reason: op.uploadId });
    return "rejected";
  }
  if (u.status !== "open") return "noop";
  ctx.s.putUpload({ ...u, status: "committed" });
  return "applied";
}

function opUploadAbort(ctx: Ctx, op: UploadAbortOp): Outcome {
  if (!isClientId(op.uploadId)) return ctx.reject("bad_upload_id");
  if (!ctx.guarded(op.uploadId)) return ctx.reject("upload_not_guarded");
  const u = ctx.s.getUpload(op.uploadId);
  if (!u) return ctx.reject("upload_unknown");
  if (u.status === "aborted") return "noop";
  if (u.status === "bound" || u.status === "released") return ctx.reject("upload_in_use");
  ctx.s.putUpload({
    ...u,
    status: "aborted",
    ended: { seq: ctx.e.seq, at: ctx.e.serverTime, reason: "aborted", opId: ctx.e.opId },
  });
  return "applied";
}

// Re-exported for callers that build operations.
export type { Operation };

/** Uploads an operation touches; the envelope's leaseGuard must list them (rule 8). */
export function uploadsTouched(op: Operation): string[] {
  const out = new Set<string>();
  const visit = (o: SingleOp) => {
    switch (o.type) {
      case "upload_begin":
      case "upload_commit":
      case "upload_abort":
        out.add(o.uploadId);
        break;
      case "create":
        if (o.content) out.add(o.content.uploadId);
        break;
      case "new_content_version":
        out.add(o.content.uploadId);
        break;
      default:
        break;
    }
  };
  if (op.type === "group") op.ops.forEach(visit);
  else visit(op);
  return [...out].sort(cmp);
}
