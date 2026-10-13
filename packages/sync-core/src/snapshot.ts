// Index snapshots (koncept §6.2): the tree layer only (§4.1: manifests are
// stored next to the fragments and never inside the snapshot).
//
// The snapshot is canonical: nodes and uploads sorted by ID, object keys in a
// fixed order. Two replicas with the same state produce byte-identical
// snapshots, which the tests use as the equality check.

import { applyEntries, initIndex, type ApplyResult } from "./apply.js";
import { MemoryIndexStore, type IndexStore } from "./store.js";
import { MIN_REPLAY_RULES_VERSION, RULES_VERSION, type IndexMeta, type LogEntry, type NodeRecord, type UploadRecord } from "./types.js";

export const SNAPSHOT_FORMAT = "ddn-index-snapshot";
/** 2: FileVersion.plaintextSha256 and tzOffsetMin (rules v2). */
export const SNAPSHOT_FORMAT_VERSION = 2;

export interface IndexSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  formatVersion: number;
  /** Rules version of the build that wrote it. */
  writerRulesVersion: number;
  meta: IndexMeta;
  nodes: NodeRecord[];
  uploads: UploadRecord[];
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function takeSnapshot(store: IndexStore): IndexSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    writerRulesVersion: RULES_VERSION,
    meta: { ...store.getMeta() },
    nodes: [...store.allNodes()].sort(byId).map(canonicalNode),
    uploads: [...store.allUploads()].sort(byId).map(canonicalUpload),
  };
}

export function loadSnapshot(snap: IndexSnapshot, store: IndexStore = new MemoryIndexStore()): IndexStore {
  if (snap.format !== SNAPSHOT_FORMAT) throw new Error("not an index snapshot");
  if (snap.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(`unsupported snapshot format version ${snap.formatVersion}`);
  }
  if (snap.meta.rulesVersion > RULES_VERSION) {
    throw new Error(`snapshot needs rules version ${snap.meta.rulesVersion}; this build has ${RULES_VERSION}`);
  }
  // 0 = empty log. A state built by rules this build no longer replays could
  // differ from what a full replay gives, so it is not a valid base.
  if (snap.meta.rulesVersion !== 0 && snap.meta.rulesVersion < MIN_REPLAY_RULES_VERSION) {
    throw new Error(`snapshot built with rules version ${snap.meta.rulesVersion}; this build replays ${MIN_REPLAY_RULES_VERSION}..${RULES_VERSION}`);
  }
  store.atomically(() => {
    // Parents before children is not required: the store indexes by parent ID.
    for (const n of snap.nodes) store.putNode(canonicalNode(n));
    for (const u of snap.uploads) store.putUpload(canonicalUpload(u));
    store.setMeta({ ...snap.meta });
  });
  return store;
}

/** Canonical serialization of the full state (tree + uploads + meta). */
export function canonicalState(store: IndexStore): string {
  const s = takeSnapshot(store);
  return JSON.stringify({ meta: s.meta, nodes: s.nodes, uploads: s.uploads });
}

/** Replay a whole log into a fresh store. */
export function replay(entries: Iterable<LogEntry>, store: IndexStore = new MemoryIndexStore()): {
  store: IndexStore;
  results: ApplyResult[];
} {
  initIndex(store);
  const results = applyEntries(store, entries);
  return { store, results };
}

// Fixed key order, so JSON.stringify output is canonical.
function canonicalNode(n: NodeRecord): NodeRecord {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    parentId: n.parentId,
    trashed: n.trashed ? { seq: n.trashed.seq, at: n.trashed.at } : null,
    created: { seq: n.created.seq, deviceId: n.created.deviceId },
    nameChanged: { seq: n.nameChanged.seq, deviceId: n.nameChanged.deviceId },
    placed: { seq: n.placed.seq, deviceId: n.placed.deviceId },
    content: n.content
      ? {
          versionId: n.content.versionId,
          uploadId: n.content.uploadId,
          sizeBytes: n.content.sizeBytes,
          manifestRef: n.content.manifestRef,
          chunkCount: n.content.chunkCount,
          plaintextSha256: n.content.plaintextSha256,
          // Rules v3, optional: absent keeps a rules-2 state byte-identical (format version unchanged).
          ...(n.content.pieces ? { pieces: n.content.pieces.map((p) => ({ loc: p.loc, n: p.n, bytes: p.bytes })) } : {}),
          device: { id: n.content.device.id, name: n.content.device.name },
          createdAt: n.content.createdAt,
          tzOffsetMin: n.content.tzOffsetMin,
          seq: n.content.seq,
        }
      : null,
    recoveredFrom: n.recoveredFrom
      ? {
          parentId: n.recoveredFrom.parentId,
          path: n.recoveredFrom.path ? [...n.recoveredFrom.path] : null,
          seq: n.recoveredFrom.seq,
        }
      : null,
    conflictOf: n.conflictOf ? { nodeId: n.conflictOf.nodeId, seq: n.conflictOf.seq } : null,
  };
}

function canonicalUpload(u: UploadRecord): UploadRecord {
  return {
    id: u.id,
    status: u.status,
    began: { seq: u.began.seq, deviceId: u.began.deviceId },
    boundTo: u.boundTo
      ? { nodeId: u.boundTo.nodeId, versionId: u.boundTo.versionId, seq: u.boundTo.seq, deviceId: u.boundTo.deviceId }
      : null,
    ended: u.ended ? { seq: u.ended.seq, at: u.ended.at, reason: u.ended.reason, opId: u.ended.opId } : null,
    ...(u.relocated ? { relocated: { seq: u.relocated.seq, at: u.relocated.at } } : {}),
  };
}
