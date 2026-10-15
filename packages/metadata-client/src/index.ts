// @ddv4/metadata-client: discordrive-next stage 2, metadata-only mode (koncept §3, §6.5).

export * from "./types.js";
export { MemoryTransport } from "./memory-transport.js";
export { DiscordWebhookTransport, DiscordHttpError, RateLimitedError, parseWebhookUrl, redactWebhookUrl, isCloudflareBlock } from "./discord-transport.js";
export { ChannelPacer, type PacerOptions } from "./rate-limit.js";
export { LocalArbiter, type ArbiterApi } from "./arbiter.js";
export {
  FRAGMENT_FORMAT_VERSION,
  newFileKey,
  importFileKey,
  encryptFragment,
  decryptFragment,
  encryptManifest,
  decryptManifest,
  sha256Hex,
  type FileKey,
} from "./file-crypto.js";
export { type BlobStore, type BlobPutContext, type BlobGetContext, type LaneFetch, AbortedError, throwIfAborted } from "./blob-store.js";
export { DriveClient, piecesOf, readVersionRange, mbps, type DriveClientOptions, type DownloadOptions, type UploadStages, type ResumeStore, type UploadJournal, type UploadJournalFrag, resumeKeys } from "./drive-client.js";
export { AdaptiveWindow, NetControl, NetGate, NetworkError, SpeedBaseline, StuckGuard, guardedRead, isNetworkError, netCall, realClock, retryFree, type BaselineData, type GateState, type NetClock, type NetUiState } from "./net.js";
export { TransferLog, MemoryLogSink, TRANSFER_LOG_VERSION, scrubText, errText as logErrText, hostOf, nowMs, type TransferLogOptions, type TransferDir, type TransferSource, type LimiterState } from "./transfer-log.js";
// e2ee/plain clients: import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs" (kept out of this index).
export {
  MetadataClient,
  WebhookBlobStore,
  WEBHOOK_VAULT_MARKER,
  placementOf,
  OpFailedError,
  DEFAULT_CHUNK_SIZE,
  BLOB_EXT,
  MANIFEST_SCHEMA_VERSION,
  decodeManifestRef,
  encodeManifestRef,
  memorySource,
  newId,
  type ByteSink,
  type ByteSource,
  type ManifestLocator,
  type MetadataClientOptions,
  type UploadOptions,
  type UploadResult,
} from "./client.js";
export {
  accountKeyFromB64,
  accountKeyFromRaw,
  newAccountKey,
  seal,
  unseal,
  sealJson,
  unsealJson,
  UnsealError,
  ACCOUNT_KEY_BYTES,
  type AccountKey,
  type SubkeyLabel,
} from "./account-key.js";
export {
  WebhookVault,
  MemoryVaultStore,
  VaultRollbackError,
  emptyVault,
  inspectForVault,
  openVault,
  sealVault,
  toWebhookRefs,
  vaultAdvice,
  REQUIRED_CHANNELS,
  RECOMMENDED_CHANNELS,
  VAULT_FORMAT,
  VAULT_FORMAT_VERSION,
  type SealedVault,
  type VaultAdvice,
  type VaultContent,
  type VaultPutResult,
  type VaultStore,
  type VaultWebhook,
} from "./vault.js";
export {
  OpCodec,
  EncryptedArbiter,
  InProcessLogServer,
  UNDECRYPTABLE_DEVICE,
  type EncryptedEnvelope,
  type EncryptedEntry,
  type EncryptedLogApi,
} from "./op-crypto.js";
export { SqlIndexStore, manifestLoc, parseCursor, type ChildRow, type FolderStats, type ListSort, type SqlDriver, type SqlValue } from "./sql-store.js";
// Node-only (node:sqlite, server): import from "@ddv4/metadata-client/node".
export {
  clientBlobIO,
  rescueBlobIO,
  rehomeChain,
  chainObjects,
  createPointerMessage,
  readPointer,
  writePointer,
  writeSnapshot,
  decideSnapshot,
  restoreFromDiscord,
  loadBase,
  pruneSnapshots,
  selectRetained,
  deletableUploadsWithRetention,
  SnapshotScheduler,
  DAILY_BASES,
  WEEKLY_BASES,
  type PruneResult,
  type SchedulerDeps,
  emptyPointer,
  encodeRescueKit,
  decodeRescueKit,
  encodeServerRescueKit,
  decodeServerRescueKit,
  readLogChain,
  type ServerRescueKit,
  gzip,
  gunzip,
  SEGMENT_QUIET_MS,
  SEGMENT_MAX_DELAY_MS,
  BASE_SEGMENT_RATIO,
  BASE_MAX_AGE_MS,
  type BlobIO,
  type BaseRef,
  type ObjRef,
  type Pointer,
  type PointerLocation,
  type RescueKit,
  type RestoreResult,
  type SegmentRef,
  type SnapshotClock,
  type SnapshotDecision,
  type SnapshotDeps,
  type SnapshotResult,
} from "./snapshots.js";
export {
  protectAccountKey,
  passwordProof,
  passwordStrength,
  signInWithPassword,
  checkArgon2Params,
  normalizeLogin,
  validLogin,
  PASSWORD_ARGON2,
  MIN_PASSWORD_LENGTH,
  type Argon2Params,
  type PasswordKeyUpload,
} from "./password-key.js";
export { HttpApi, HttpPairingMailbox, ServerError, createAccountHttp, getChallenge, getHealth, passwordParams, passwordSealedKey, rescueRegisterDevice, type HttpSession, type ServerDevice } from "./http-api.js";
export { sealDeviceName, openDeviceName, cleanDeviceName, MAX_DEVICE_NAME } from "./device-names.js";
export { prepareShare, prepareShareWith, shareLink, parseShareLink, openShare, attachmentFilename, type ShareMeta, type ShareAttachment, type OpenedShare } from "./share.js";
export {
  generateDeviceKey,
  deviceKeyFromCryptoKey,
  exportDeviceKey,
  importDeviceKey,
  rescueKey,
  verifySignature,
  authMessage,
  isPublicKey,
  isSignature,
  type Challenge,
  type DeviceKey,
} from "./device-key.js";
export {
  ChannelMover,
  ChainIndex,
  DRAIN_AFTER_MS,
  RELOCATE_BATCH,
  backfillPieces,
  estimateMs,
  finishDrain,
  refreshUnavailable,
  snapshotHooks,
  type ChannelClient,
  type ChannelsDeps,
  type CriticalWhat,
  type MoveState,
} from "./channels.js";
export { Cleaner, CLEANUP_MAX_UPLOADS, findUploadContent, purgeExpiredTrash, releasedUploads, type CleanupApi, type CleanupDeps, type CleanupPreview, type CleanupReport, type CleanupServerStatus } from "./cleanup.js";
export {
  LogObserver,
  decideTrashCleanup,
  trashCleanupOp,
  ANY_DEVICE_CLEANS_AFTER_MS,
  INVALID_OP_WARN_AFTER,
  type InvalidOpAlert,
  type TrashCleanupContext,
  type TrashCleanupDecision,
} from "./policies.js";
export {
  startPairing,
  acceptPairing,
  parseOffer,
  MemoryPairingMailbox,
  PAIRING_TTL_MS,
  type PairingBundle,
  type PairingMailbox,
  type PendingPairing,
} from "./pairing.js";
export { handleStreamRequest, parseRange, STREAM_PREFIX, MAX_OPEN_RANGE } from "./stream.js";
