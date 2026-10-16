// Deterministic application of log entries to the index.
//
// Contract:
//  - The result depends only on the current state and the entry. No
//    clocks, no randomness, no locale, no engine-dependent Unicode tables.
//    Iteration over children is always sorted by ID.
//  - Order comes only from entry.seq assigned by the server.
//  - A malformed or semantically invalid operation is never an exception: it
//    is consumed as a deterministic no-op ("rejected") with a notice, so one
//    bad client cannot stall every replica. Exceptions mean a bug in the core
//    (or a log gap / unsupported rules version).
//  - Each entry is applied in a write overlay and committed atomically. A
//    group op (owner decision Q9; DECISIONS.md): members skipped by a
//    conflict rule are left out (each in its own nested overlay, so a skipped
//    member never leaves traces) and the rest applies, with one summary
//    notice; a rejected (invalid) member rolls back the whole group.

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
  type PieceLoc,
  type PurgeOp,
  type RelocateOp,
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
  /**
   * Q3: purge deleted only what its author had seen; these nodes (`items`,
   * subtree roots) stay in the trash and their 30-day clock restarts.
   */
  | "purge_kept_unseen"
  /**
   * Q1: a node changed by another device (added/moved/restored or new
   * content) that the trashing author had not seen went to the trash with
   * the folder. Addressed to `notifyDeviceId`; relatedNodeId = the folder.
   */
  | "unseen_trashed_with_folder"
  /** Q2: trash of a file skipped, it has new content the author had not seen. Silent. */
  | "trash_skipped_unseen_content"
  /** Q7: concurrent version with identical content (same plaintext hash), no conflict copy. Silent. */
  | "content_identical"
  /** Group op rolled back because a sub-op was rejected (Q9). */
  | "group_rolled_back"
  /** Group op applied without the members a conflict rule skipped; `items` lists their indexes (Q9). */
  | "group_members_skipped"
  /** Rules v3: relocate of a version that is no longer current (purged/superseded meanwhile). Silent. */
  | "relocate_stale"
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
  /**
   * Device that should be told, when it is not the author of the operation
   * (e.g. Q1: the author of a change that went to the trash with a folder).
   */
  notifyDeviceId?: string;
  /** Summary lists (Q3: nodes kept in the trash, Q9: skipped member indexes). */
  items?: string[];
  /** Deterministic, but the UI does not show it by default (Q2). */
  silent?: true;
}

/** Notices kept for debugging/telemetry that the UI hides by default (Q2). */
export const SILENT_NOTICE_CODES: ReadonlySet<NoticeCode> = new Set<NoticeCode>([
  "trash_skipped_unseen_content",
  "content_identical",
  "relocate_stale",
]);

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
  // Rules 2 and 3 are replayable. They differ only in what v3 added (relocate, content
  // pieces), and those branch on entry.rulesVersion where they are read (applySingle,
  // validateContent, toVersion), so a rules-2 entry gives exactly its old result.

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
  const groupStore = ctx.s;
  const groupFirstNotice = ctx.notices.length;
  let any = false;
  const skipped: string[] = [];
  let allSkipsSilent = true;
  for (let i = 0; i < ops.length; i++) {
    const sub = ops[i] as SingleOp;
    if (!sub || typeof sub !== "object" || (sub as { type?: unknown }).type === "group") {
      ctx.notices = ctx.notices.slice(0, groupFirstNotice);
      ctx.notice({ code: "invalid_op", reason: "bad_group_member" });
      ctx.notice({ code: "group_rolled_back", reason: `sub_${i}` });
      return "rejected";
    }
    // Each member in its own overlay: a skipped member is dropped as a whole.
    const memberStore = new OverlayStore(groupStore);
    ctx.s = memberStore;
    const firstNotice = ctx.notices.length;
    const r = applySingle(ctx, sub, i);
    ctx.s = groupStore;
    if (r === "rejected") {
      // Q9: an invalid member means a broken operation: roll back everything.
      // Notices of the members applied before it describe changes that did
      // not happen; keep only the rejected member's and the rollback notice.
      ctx.notices = [...ctx.notices.slice(0, groupFirstNotice), ...ctx.notices.slice(firstNotice)];
      ctx.notice({ code: "group_rolled_back", reason: `sub_${i}` });
      return r;
    }
    if (r === "skipped") {
      skipped.push(String(i));
      if (!ctx.notices.slice(firstNotice).every((n) => n.silent)) allSkipsSilent = false;
      continue;
    }
    memberStore.commit();
    if (r === "applied") any = true;
  }
  if (skipped.length > 0) {
    // Q9: one summary notice listing the members that were left out.
    ctx.notice({ code: "group_members_skipped", items: skipped, ...(allSkipsSilent ? { silent: true as const } : {}) });
  }
  if (any) return "applied";
  return skipped.length > 0 ? "skipped" : "noop";
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
    case "relocate":
      // Rules v3 only: in an entry of rules 2 it stays what it was then, an unknown type.
      if (ctx.e.rulesVersion >= 3) return opRelocate(ctx, op);
      ctx.notice({ code: "invalid_op", reason: "unknown_type" });
      return "rejected";
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
    /** Write target; a group swaps in a per-member overlay. */
    public s: IndexStore,
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
    const silent = SILENT_NOTICE_CODES.has(n.code) ? { silent: true as const } : {};
    this.notices.push({ seq: this.e.seq, opId: this.e.opId, deviceId: this.e.device.id, ...silent, ...n });
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
  if (e.tzOffsetMin !== undefined && !isTzOffset(e.tzOffsetMin)) return "bad_tz_offset";
  if (e.leaseGuard !== undefined && (!Array.isArray(e.leaseGuard) || !e.leaseGuard.every(isClientId))) {
    return "bad_lease_guard";
  }
  if (!e.op || typeof e.op !== "object") return "bad_op";
  return null;
}

/** UTC offset in minutes, -18h..+18h (the range JS/ICU and every real zone stay within). */
export function isTzOffset(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= -1080 && (v as number) <= 1080;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function validateContent(c: unknown, rulesVersion: number): string | null {
  if (!c || typeof c !== "object") return "content_missing";
  const x = c as ContentRef;
  if (!isClientId(x.versionId)) return "bad_version_id";
  if (!isClientId(x.uploadId)) return "bad_upload_id";
  if (!Number.isSafeInteger(x.sizeBytes) || x.sizeBytes < 0) return "bad_size";
  if (!Number.isSafeInteger(x.chunkCount) || x.chunkCount < 0) return "bad_chunk_count";
  if (!isRef(x.manifestRef)) return "bad_manifest_ref";
  if (x.plaintextSha256 !== undefined && (typeof x.plaintextSha256 !== "string" || !SHA256_HEX_RE.test(x.plaintextSha256))) {
    return "bad_plaintext_hash";
  }
  // Rules 2 ignored unknown fields (toVersion copies known ones only): keep it so for old entries.
  if (rulesVersion >= 3 && x.pieces !== undefined && !validPieces(x.pieces)) return "bad_pieces";
  return null;
}

/** Piece locations (rules v3): sorted by loc, unique, at most 64 entries, counts and bytes non-negative integers. */
function validPieces(p: unknown): p is PieceLoc[] {
  if (!Array.isArray(p) || p.length > 64) return false;
  let prev = "";
  for (const x of p as PieceLoc[]) {
    if (!x || typeof x !== "object" || !isRef(x.loc) || x.loc.length > 64 || x.loc <= prev) return false;
    if (!Number.isSafeInteger(x.n) || x.n < 1 || !Number.isSafeInteger(x.bytes) || x.bytes < 0) return false;
    prev = x.loc;
  }
  return true;
}

const copyPieces = (p: PieceLoc[]): PieceLoc[] => p.map((x) => ({ loc: x.loc, n: x.n, bytes: x.bytes }));

/** Copy only known fields: payloads come from other clients and are replicated as-is. */
function toVersion(ctx: Ctx, c: ContentRef): FileVersion {
  return {
    versionId: c.versionId,
    uploadId: c.uploadId,
    sizeBytes: c.sizeBytes,
    manifestRef: c.manifestRef,
    chunkCount: c.chunkCount,
    plaintextSha256: c.plaintextSha256 ?? null,
    // Rules v3 field; an entry of rules 2 builds exactly the version it built then.
    ...(ctx.e.rulesVersion >= 3 && c.pieces ? { pieces: copyPieces(c.pieces) } : {}),
    device: { id: ctx.e.device.id, name: ctx.e.device.name },
    createdAt: ctx.e.createdAt,
    tzOffsetMin: ctx.e.tzOffsetMin ?? 0,
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
    const cErr = validateContent(op.content, ctx.e.rulesVersion) ?? checkUploadUsable(ctx, op.content!.uploadId);
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
  if (node.content && ctx.unseen(contentMark(node.content))) {
    // Rule 3 in the other order, decision Q2 in packages/sync-core/DECISIONS.md: new content the author
    // has not seen keeps the file alive (with rule 3's order the file would
    // come back from the trash anyway). The notice is silent.
    ctx.notice({ code: "trash_skipped_unseen_content", nodeId: node.id });
    return "skipped";
  }
  ctx.s.putNode({ ...node, trashed: { seq: ctx.e.seq, at: ctx.e.serverTime } });
  if (node.kind === "folder") notifyUnseenTrashed(ctx, node.id);
  return "applied";
}

function contentMark(c: FileVersion): ChangeMark {
  return { seq: c.seq, deviceId: c.device.id };
}

/**
 * Rule 4 in the other order, owner decisions Q1 and #11 (the folder-exception
 * rule): trashing a folder trashes the WHOLE folder, including nodes the
 * trashing author had not seen (added, moved in or restored after its
 * baseSeq) and files with unseen new content. Nothing is rescued to
 * „Odzyskane”; instead every device whose unseen change went to the trash
 * gets a notice (the trash keeps it for 30 days, so it is reversible).
 * Trashing such a file on its own is still skipped (Q2, opTrash).
 *
 * One notice per (device, topmost node with that device's unseen change):
 * a device that uploaded a folder with 1000 files gets one notice, not 1001.
 * Nodes trashed on their own earlier are skipped (they were already in the trash).
 */
function notifyUnseenTrashed(ctx: Ctx, folderId: NodeId): void {
  // Depth-first, children in ascending ID order; `told` = devices already
  // notified about an ancestor on the current path.
  const stack: { id: NodeId; told: ReadonlySet<string> }[] = [{ id: folderId, told: new Set() }];
  const visited = new Set<NodeId>(); // defensive: the tree has no cycles (rule 6)
  while (stack.length > 0) {
    const { id, told } = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const descend: { id: NodeId; told: ReadonlySet<string> }[] = [];
    for (const kid of sortedChildren(ctx.s, id)) {
      const rec = ctx.s.getNode(kid)!;
      if (rec.trashed) continue;
      const devices = new Set<string>();
      if (ctx.unseen(rec.placed)) devices.add(rec.placed.deviceId);
      if (rec.content && ctx.unseen(contentMark(rec.content))) devices.add(rec.content.device.id);
      let next = told;
      for (const dev of [...devices].sort(cmp)) {
        if (told.has(dev)) continue;
        ctx.notice({
          code: "unseen_trashed_with_folder",
          nodeId: rec.id,
          relatedNodeId: folderId,
          notifyDeviceId: dev,
          reason: dev === rec.placed.deviceId && ctx.unseen(rec.placed) ? "placed" : "content",
        });
        if (next === told) next = new Set(told);
        (next as Set<string>).add(dev);
      }
      if (rec.kind === "folder") descend.push({ id: kid, told: next });
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
  // Owner decision Q3: delete what the author had seen. A node whose place or
  // content the author had not seen stays in the trash with its whole
  // subtree; its ancestors up to the purged node stay as containers (so
  // nothing is orphaned). The 30-day clock of the kept nodes restarts.
  const doomed: NodeId[] = [];
  const keptRoots: NodeId[] = [];
  const containers = new Set<NodeId>();
  const walk: { id: NodeId; path: NodeId[] }[] = [{ id: node.id, path: [] }];
  const visited = new Set<NodeId>(); // defensive: the tree has no cycles (rule 6)
  while (walk.length > 0) {
    const { id, path } = walk.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const rec = ctx.s.getNode(id)!;
    const unseen = ctx.unseen(rec.placed) || (rec.content !== null && ctx.unseen(contentMark(rec.content)));
    if (unseen) {
      keptRoots.push(id);
      for (const a of path) containers.add(a);
      continue;
    }
    doomed.push(id);
    for (const kid of sortedChildren(ctx.s, id)) walk.push({ id: kid, path: [...path, id] });
  }
  if (keptRoots.length === 0) {
    doomed.sort(cmp);
    for (const id of doomed) {
      const rec = ctx.s.getNode(id)!;
      if (rec.content) releaseUpload(ctx, rec.content.uploadId, "purged");
      ctx.s.deleteNode(id);
    }
    return "applied";
  }
  const toDelete = doomed.filter((id) => !containers.has(id)).sort(cmp);
  for (const id of toDelete) {
    const rec = ctx.s.getNode(id)!;
    if (rec.content) releaseUpload(ctx, rec.content.uploadId, "purged");
    ctx.s.deleteNode(id);
  }
  // Restart the clock that expiredTrash() reads: the topmost trashed node on
  // the chain from the purged node up (purged node itself or an ancestor).
  let top: NodeRecord | undefined;
  for (let cur: NodeRecord | undefined = node, guard = 0; cur && guard < 1_000_000; guard++) {
    if (cur.trashed) top = cur;
    cur = cur.parentId === null ? undefined : ctx.s.getNode(cur.parentId);
  }
  if (top) ctx.s.putNode({ ...top, trashed: { seq: top.trashed!.seq, at: ctx.e.serverTime } });
  keptRoots.sort(cmp);
  ctx.notice({ code: "purge_kept_unseen", nodeId: node.id, items: keptRoots });
  return "applied";
}

function opNewContent(ctx: Ctx, op: NewContentVersionOp): Outcome {
  if (!isRef(op.nodeId)) return ctx.reject("bad_node_id");
  if (SYSTEM_IDS.has(op.nodeId)) return ctx.reject("system_node", op.nodeId);
  if (op.baseVersionId !== null && !isRef(op.baseVersionId)) return ctx.reject("bad_base_version", op.nodeId);
  const cErr = validateContent(op.content, ctx.e.rulesVersion) ?? checkUploadUsable(ctx, op.content.uploadId);
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
  const identical =
    cur !== null && cur.plaintextSha256 !== null && cur.plaintextSha256 === version.plaintextSha256;
  if (cur && cur.versionId !== op.baseVersionId && identical) {
    // Owner decision Q7: same plaintext as the current version, so nothing
    // can be lost: no conflict, no copy. The later version becomes current.
    ctx.notice({ code: "content_identical", nodeId: rec.id });
  }
  if (cur && cur.versionId !== op.baseVersionId && !identical) {
    // Rule 7: the later version is current; the earlier one stays as a visible copy.
    // (Also when the author knew no version at all, baseVersionId = null, Q7.)
    const copyId = ctx.derivedId("conflict");
    const copy: NodeRecord = {
      id: copyId,
      kind: "file",
      // Q6: local time of the losing version's author, from its envelope offset.
      name: conflictName(rec.name, cur.device.name, cur.createdAt, cur.tzOffsetMin),
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

/**
 * Rules v3: the bound version's bytes now live elsewhere (a storage location was moved away).
 * Only the locator changes: version ID, seq, author and plaintext hash stay, so it is never a
 * conflict and never "unseen content" (Q2/Q3 look at the version's seq). Stale (the upload is no
 * longer bound to that version: purged or superseded meanwhile, or another relocate changed the
 * locator first: `from` no longer matches) = skipped silently; the mover deletes its copies.
 */
function opRelocate(ctx: Ctx, op: RelocateOp): Outcome {
  if (!isClientId(op.uploadId)) return ctx.reject("bad_upload_id");
  if (!isClientId(op.versionId)) return ctx.reject("bad_version_id");
  if (!isRef(op.manifestRef) || !isRef(op.from)) return ctx.reject("bad_manifest_ref");
  if (op.pieces !== undefined && !validPieces(op.pieces)) return ctx.reject("bad_pieces");
  const u = ctx.s.getUpload(op.uploadId);
  const node = u?.status === "bound" && u.boundTo?.versionId === op.versionId ? ctx.s.getNode(u.boundTo.nodeId) : undefined;
  if (!u || !node || node.content?.versionId !== op.versionId || node.content.uploadId !== op.uploadId || node.content.manifestRef !== op.from) {
    ctx.notice({ code: "relocate_stale", reason: op.uploadId });
    return "skipped";
  }
  const c = node.content;
  const pieces = op.pieces ? copyPieces(op.pieces) : undefined;
  if (op.from === op.manifestRef && JSON.stringify(c.pieces ?? null) === JSON.stringify(pieces ?? null)) return "noop";
  const { pieces: _old, ...rest } = c;
  ctx.s.putNode({ ...node, content: { ...rest, manifestRef: op.manifestRef, ...(pieces ? { pieces } : {}) } });
  // from == manifestRef: only the piece locations were filled in (read from the manifest); nothing moved.
  if (op.from !== op.manifestRef) ctx.s.putUpload({ ...u, relocated: { seq: ctx.e.seq, at: ctx.e.serverTime } });
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
