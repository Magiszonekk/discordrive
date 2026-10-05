// discordrive-next sync core: data model (koncept §4, §4.1, §5).

export type NodeId = string;
export type OpId = string;
export type UploadId = string;
export type VersionId = string;
export type NodeKind = "file" | "folder";

/**
 * Rules version implemented by this build. Recorded in every log entry (§5.4).
 *
 * History:
 *  1 - first stage-1 rules (provisional answers to the stage-1 questions).
 *  2 - owner decisions of 2026-10-05 (DECISIONS.md): folder trash takes unseen
 *      nodes along (Q1), silent trash skip (Q2), partial purge keeping unseen
 *      nodes (Q3), conflict copy in the author's local time (Q6), identical
 *      content is not a conflict (Q7), group ops skip only "skipped" members (Q9).
 */
export const RULES_VERSION = 2;
/**
 * Oldest rules version this build can still replay. Version 1 logs are not
 * replayable: no v1 log exists outside tests (stage 1 never ran against a
 * real server), so keeping a second rule set would be cost without data.
 */
export const MIN_REPLAY_RULES_VERSION = 2;

/** Fixed system node IDs. Both are roots (parentId = null) and can never be deleted. */
export const ROOT_ID: NodeId = "root";
/** System folder „Odzyskane” (rule 3b/4). Separate root, so its name never collides with user folders. */
export const RECOVERED_ID: NodeId = "recovered";
export const SYSTEM_IDS: ReadonlySet<NodeId> = new Set([ROOT_ID, RECOVERED_ID]);

export interface DeviceInfo {
  /** Stable device ID (random). */
  id: string;
  /** Human label shown in conflict copies (rule 7). */
  name: string;
}

// ---------------------------------------------------------------------------
// Content (tree layer only keeps a pointer; the chunk list lives in the manifest layer)

/** Content payload carried by create/new_content_version. */
export interface ContentRef {
  /** Random, client-generated. Identifies this version of this file. */
  versionId: VersionId;
  /** Upload whose fragments hold this version (rule 8). Must be committed and unused. */
  uploadId: UploadId;
  /** Plaintext size in bytes (display). */
  sizeBytes: number;
  /**
   * Opaque locator of the (encrypted) manifest in the manifest layer (§4.1).
   * The tree never contains chunk lists.
   */
  manifestRef: string;
  chunkCount: number;
  /**
   * SHA-256 of the file plaintext, lowercase hex (Q7). The uploading client
   * computes it while streaming the plaintext through the chunker, before
   * encryption; it travels only inside the (encrypted) op payload and the
   * (encrypted) tree, so the server never sees it in metadata only. Optional:
   * without it a concurrent version is always a conflict.
   */
  plaintextSha256?: string;
}

/** A version as stored in the tree. */
export interface FileVersion extends Omit<ContentRef, "plaintextSha256"> {
  plaintextSha256: string | null;
  /** Who wrote it and when (device clock, display only: rule 7 copy label). */
  device: DeviceInfo;
  createdAt: number;
  /** Author's UTC offset in minutes at createdAt (envelope tzOffsetMin, Q6). */
  tzOffsetMin: number;
  /** Log position that made it current. */
  seq: number;
}

export interface ChangeMark {
  seq: number;
  deviceId: string;
}

export interface NodeRecord {
  id: NodeId;
  kind: NodeKind;
  /** Effective name (after rule-2 suffixing). Unique among non-trashed siblings (case-folded). */
  name: string;
  /** null only for the two system roots. */
  parentId: NodeId | null;
  /**
   * Set when the node itself was trashed (not when an ancestor was).
   * seq: the trash op. at: start of the 30-day retention clock (server time of
   * the trash op; reset by a purge that had to keep unseen nodes, Q3).
   */
  trashed: { seq: number; at: number } | null;
  created: ChangeMark;
  nameChanged: ChangeMark;
  /** Last time the node was put where it is now: create, move, restore, recovery. */
  placed: ChangeMark;
  /** Files only. */
  content: FileVersion | null;
  /** Set when the node landed in „Odzyskane” by a rule (3, 3b, 4). */
  recoveredFrom: { parentId: NodeId | null; path: string[] | null; seq: number } | null;
  /** Set on rule-7 conflict copies. */
  conflictOf: { nodeId: NodeId; seq: number } | null;
}

export type UploadStatus =
  /** upload_begin applied, fragments may be in flight. */
  | "open"
  /** upload_commit applied: fragments final, not yet referenced by a file. */
  | "committed"
  /** Referenced by exactly one file version. */
  | "bound"
  /** Was bound, the version is gone (purged or superseded). Fragments deletable after retention. */
  | "released"
  /** upload_abort applied. Fragments deletable right away. */
  | "aborted";

export interface UploadRecord {
  id: UploadId;
  status: UploadStatus;
  began: ChangeMark;
  /** For bound/released: the version that uses (used) the fragments. */
  boundTo: { nodeId: NodeId; versionId: VersionId; seq: number; deviceId: string } | null;
  /** For released/aborted. */
  ended: { seq: number; at: number; reason: "purged" | "superseded" | "aborted"; opId: OpId } | null;
}

export interface IndexMeta {
  /** Last applied log position (0 = empty log). */
  headSeq: number;
  /** Highest rules version seen in the applied log. */
  rulesVersion: number;
}

// ---------------------------------------------------------------------------
// Operations (§4). All reference node IDs, never paths.

export interface CreateOp {
  type: "create";
  nodeId: NodeId;
  kind: NodeKind;
  parentId: NodeId;
  name: string;
  /** Required for files, forbidden for folders. */
  content?: ContentRef;
}
export interface RenameOp {
  type: "rename";
  nodeId: NodeId;
  name: string;
}
export interface MoveOp {
  type: "move";
  nodeId: NodeId;
  parentId: NodeId;
}
export interface TrashOp {
  type: "trash";
  nodeId: NodeId;
}
export interface RestoreOp {
  type: "restore";
  nodeId: NodeId;
}
export interface PurgeOp {
  type: "purge";
  nodeId: NodeId;
}
export interface NewContentVersionOp {
  type: "new_content_version";
  nodeId: NodeId;
  /** Version the author edited (null if the author never saw any version). */
  baseVersionId: VersionId | null;
  content: ContentRef;
  /** Name the author knew; used when the file was purged meanwhile (rule 3b). */
  nameHint: string;
}
export interface UploadBeginOp {
  type: "upload_begin";
  uploadId: UploadId;
}
export interface UploadCommitOp {
  type: "upload_commit";
  uploadId: UploadId;
}
export interface UploadAbortOp {
  type: "upload_abort";
  uploadId: UploadId;
}
/**
 * Group operation (Q9): members skipped by a conflict rule are left out and
 * the rest applies; a rejected (invalid) member rolls back the whole group.
 */
export interface GroupOp {
  type: "group";
  ops: SingleOp[];
}

export type SingleOp =
  | CreateOp
  | RenameOp
  | MoveOp
  | TrashOp
  | RestoreOp
  | PurgeOp
  | NewContentVersionOp
  | UploadBeginOp
  | UploadCommitOp
  | UploadAbortOp;

export type Operation = SingleOp | GroupOp;

/** What a client submits (op payload is encrypted in the real system; opId/rulesVersion/baseSeq/leaseGuard are plaintext for the server). */
export interface OpEnvelope {
  opId: OpId;
  rulesVersion: number;
  /** Last log position the author had applied when it created the op (§4). */
  baseSeq: number;
  device: DeviceInfo;
  /** Device clock, display only (§5.2.1). */
  createdAt: number;
  /**
   * Author's UTC offset in minutes at createdAt (CEST = 120). Display only:
   * the rule-7 conflict copy name shows the author's local time (Q6).
   * Integer in [-1080, 1080]; missing = 0.
   */
  tzOffsetMin?: number;
  /**
   * Rule 8: uploads this op touches (begin/commit/abort, or content bound by
   * create/new_content_version). Plaintext, like the leases themselves (§3.3).
   * The server accepts the op only while the submitting device holds an
   * unexpired lease on each of them; apply() rejects upload-touching ops
   * that do not list their upload here.
   */
  leaseGuard?: UploadId[];
  op: Operation;
}

/** A log entry: envelope + position assigned by the server (arbiter). */
export interface LogEntry extends OpEnvelope {
  seq: number;
  /** Server clock at sequencing. Used for retention timers only, never for ordering. */
  serverTime: number;
}
