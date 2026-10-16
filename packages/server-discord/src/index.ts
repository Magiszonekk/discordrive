// @ddv4/server-discord: what the e2ee and plain instances use to talk to Discord.
// Node only.
export { DiscordSender, DiscordUnavailableError, NoChannelError, SERVER_BLOBS_MARKER, type SenderHook, type SenderOptions } from "./sender.js";
export { InstanceHooks, POOL, INSTANCE_KEY_FILE, MAX_ACCOUNT_CHANNELS, loadInstanceKey, instanceSubkey, type HookInfo, type RemovedHook, type CachedHook } from "./instance-hooks.js";
export { BlobsExtension, ByteBudget, MAX_BLOB_BYTES, DEFAULT_INFLIGHT_BYTES, FRAGMENT_RETENTION_MS, type BlobsExtensionOptions, type BlobRow } from "./blobs-ext.js";
export { SnapshotsExtension, serverSnapshotKey, serverBlobIO, rebuildAccountLog, backfillSnapshotObjects, snapshotTables, REWRITE_SEGMENT_ENTRIES, type SnapshotsExtensionOptions, type SnapObj } from "./snapshots-ext.js";
export { ChannelStore, ChannelMover, ChannelError, blobTables, etaMs, MOVE_RETRY_MS, IMPACT_MAX_UPLOADS, type ChannelStats, type MoveJobRow, type MoveStatusJson, type MoverDeps } from "./channels.js";
export { serverBlobsMode, type ServerBlobsMode, type ServerBlobsModeOptions } from "./mode.js";
// plain mode only (kept out of this index so an e2ee bundle never contains it):
//   import { PlainExtension } from "@ddv4/server-discord/plain"
export { ServerTransferLogs, SERVER_LOG_MAX_BYTES, type ServerTransferLogsOptions } from "./transfer-logs.js";
