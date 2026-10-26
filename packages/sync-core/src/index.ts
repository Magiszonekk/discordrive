// @ddv4/sync-core: discordrive-next shared core.
// No Discord, no database driver, no UI. Runs in Node and in the browser.

export * from "./types.js";
export {
  applyEntry,
  applyEntries,
  initIndex,
  inTrash,
  isClientId,
  isTzOffset,
  SILENT_NOTICE_CODES,
  pathOf,
  spaceOf,
  rulesVersionFor,
  uploadsTouched,
  LogGapError,
  UnsupportedRulesVersionError,
  type ApplyResult,
  type Notice,
  type NoticeCode,
  type Outcome,
} from "./apply.js";
export { MemoryIndexStore, OverlayStore, type IndexStore } from "./store.js";
export { Sequencer, type Lease, type Sequenced, type SequencedEnvelope, type SequencerOptions, type SubmitResult } from "./sequencer.js";
export {
  canonicalState,
  loadSnapshot,
  replay,
  takeSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  type IndexSnapshot,
} from "./snapshot.js";
export { checkInvariants, type InvariantViolation } from "./invariants.js";
export {
  conflictName,
  foldName,
  formatConflictDate,
  nameKey,
  normalizeName,
  sanitizeLabel,
  splitExt,
  suffixedName,
  validateName,
  MAX_NAME_LENGTH,
} from "./names.js";
export { CASEFOLD_UNICODE_VERSION } from "./casefold-table.js";
export { Replica, type ReplicaOptions } from "./replica.js";
export { ManifestCache, type ManifestSource, type ChunkManifest, type ChunkRef } from "./manifest.js";
export { deletableUploads, expiredTrash, DAY_MS, TRASH_RETENTION_MS, FRAGMENT_RETENTION_MS } from "./gc.js";
