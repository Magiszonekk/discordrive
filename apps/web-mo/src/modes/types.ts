// What a mode adds to the browser app core (docs/stage3-modes.md §2). app-core.ts imports
// `ddn:mode`; the build (build.ts, esbuild plugin) resolves it to ONE of the files next to
// this one, so the code of the other modes is not even parsed into the bundle:
//   metadata-only.ts  webhook vault, posts straight to Discord, client snapshots
//   e2ee.ts           blobs through the instance, channels on the server, server snapshots
//   plain.ts          e2ee + operations in clear for the server (thumbnails, search)
// For typechecking, tsconfig maps `ddn:mode` to metadata-only.ts; every mode file is checked
// against ModeImpl below.

import type { IndexStore } from "@ddv4/sync-core";
import type { AccountKey, ArbiterApi, DriveClient, HttpApi, NetControl, ShareAttachment } from "@ddv4/metadata-client";

export type ModeName = "metadata-only" | "e2ee" | "plain";

export interface StoredAccountLike {
  serverUrl: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  accountKey: string;
}

export interface ModeCtx {
  acct: StoredAccountLike;
  key: AccountKey;
  http: HttpApi;
  store: IndexStore;
  /** Wrap an arbiter so the core remembers server times of entries. */
  timed(a: ArbiterApi): ArbiterApi;
  /** Main tab (owns OPFS, may write snapshots). */
  leader(): boolean;
  /** Test hook: Discord API origin of the fake (metadata only posts there). */
  discordApiOrigin?: string;
  serverTimeOf(seq: number): number | undefined;
  /** Network state shared by every client this tab builds (gate, windows, guard; zlecenie 2026-10-15-transfery). */
  net?: NetControl;
}

/** One own channel (webhook) with what lies on it (zlecenie 2026-10-13-webhooki p. 1–2). */
export interface ChannelRow {
  id: string;
  channelId: string;
  label: string;
  alive?: boolean;
  /** Retired: gets no new fragments, still read (option 1, can be undone). */
  retired: boolean;
  /** Holds what the account cannot be rebuilt without (pointer message, snapshot segments/bases): only "move and remove". */
  critical: boolean;
  /** Why critical (UI tooltip). */
  criticalWhat: ("pointer" | "snapshots")[];
  /**
   * Files (current versions, trash included) with at least one piece (fragment or manifest) here.
   * e2ee/plain: committed (or released, not yet deleted) uploads of this account with a blob here.
   */
  files: number;
  /** Bytes stored here (ciphertext of those pieces). */
  bytes: number;
  /**
   * Files that cannot be read without this channel (a piece here has no copy elsewhere). Today every piece exists
   * once, so this equals `files`; kept apart for replicas later.
   */
  dependent: number;
}

/** A channel that left the account; files with pieces on it are unavailable until it is pasted again. */
export interface RemovedChannel {
  id: string;
  channelId: string;
  label: string;
  removedAt: number;
  /** "moved": data was moved off it first (nothing unavailable); "removed": removed anyway. */
  how: "moved" | "removed";
  /** Files that still have pieces only there. */
  unavailableFiles: number;
}

export interface ChannelsView {
  /** Channels this account posts to that it added itself. */
  webhooks: ChannelRow[];
  advice: { ok: boolean; channels: number; suggestMore: boolean; sharedChannels: string[] };
  /** e2ee/plain: the instance pool (count only; the URLs never leave the server). */
  pool?: { channels: number; alive: number };
  using?: "own" | "pool" | "none";
  /** Channels removed from this account (newest first). */
  removed: RemovedChannel[];
  /** A "move and remove" in progress or the last one (null = none). */
  move: MoveStatus | null;
  /** e2ee/plain: the instance has a bot, so files of a removed channel can be recovered (read through the bot, moved to active channels). */
  botRecovery?: boolean;
}

/** What removing one channel does (the remove dialog). */
export interface RemovalImpact {
  webhookId: string;
  label: string;
  critical: boolean;
  criticalWhat: ("pointer" | "snapshots")[];
  /** Files that become unavailable if it is removed without moving (pieces only there). */
  files: number;
  bytes: number;
  /** Up to 1000 of them, by name (names from the local index); `more` = the rest. */
  list: { id: string; name: string; size: number; trashed: boolean }[];
  more: number;
  /** Other channels that take new fragments (not retired). 0 = "move" is impossible ("add another channel first"). */
  otherActive: number;
  /** Bytes a move has to copy (data + manifests + snapshot objects on it). */
  moveBytes: number;
  /** Rough duration of a move (ms) from the per-channel limits; null = unknown. */
  moveEtaMs: number | null;
  retired: boolean;
  /** metadata only: files whose piece locations are still being read from their manifests (the counts may grow). */
  checking?: number;
  /** The only place this account can post to: removing (any way) is refused until another channel is added. */
  last?: boolean;
}

export interface MoveStatus {
  webhookId: string;
  label: string;
  state: "running" | "paused" | "done" | "failed";
  critical: boolean;
  /** Units moved / to move: files (versions) in metadata only, blobs on the instance (e2ee/plain). */
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  etaMs: number | null;
  error?: string;
  /** metadata only, critical: the move wrote a new pointer, the old rescue kit no longer works. */
  newKitNeeded?: boolean;
}

/** Settings → Storage totals (local index, SQL). */
export interface StorageTotals {
  files: number;
  bytes: number;
  trashFiles: number;
  trashBytes: number;
  unavailableFiles: number;
  unavailableBytes: number;
  /** Whole account on Discord: pieces of every file incl. encryption overhead + manifests (+ snapshots in metadata only); null = unknown. */
  discordBytes: number | null;
  /** How long the counting took (ms), for the evidence. */
  tookMs: number;
}

/** Settings → Storage: what the trash/fragment cleanup did and what waits (zlecenie 2026-10-13 p. 2). */
export interface StorageStatus {
  /** Who deletes fragments: this browser (metadata only) or the instance in the background. */
  by: "client" | "server";
  lastRunAt: number | null;
  /** Trash items older than 30 days (purged by the next run). */
  expired: number;
  /** Released uploads still in their 30-day window (or held by a kept snapshot). */
  waiting: number;
  /** Released uploads the next run deletes. */
  due: number;
  /** Bytes the next run frees (metadata only: plaintext sizes; server: stored ciphertext of the due ones). */
  dueBytes: number;
  /** When the oldest waiting upload becomes deletable (server clock), null = nothing waits. */
  nextAt: number | null;
}
export interface StorageRun {
  purged: number;
  kept: number;
  uploads: number;
  messages: number;
  bytes: number;
  left: number;
  trashSkipped: string | null;
}
export interface ModeCleanup {
  status(): Promise<StorageStatus>;
  /** One run; manual = "Clean up now" on this device (main-device / metered gates off). */
  run(manual: boolean): Promise<StorageRun>;
}
export interface CleanupCtx {
  primary(): boolean;
  metered(): boolean;
}

export interface ModeImpl {
  readonly mode: ModeName;
  /** Build-time check marker (grep in bundles): "ddn-mode-marker:<mode>". */
  readonly marker: string;
  /** Client around ctx.store (rebuilt when channels change). */
  client(ctx: ModeCtx): Promise<DriveClient>;
  /** `client` (when signed in): per-channel stats and the critical flag need the local index / snapshot chain. */
  channels(ctx: ModeCtx, client?: DriveClient): Promise<ChannelsView>;
  addChannel(ctx: ModeCtx, url: string): Promise<void>;
  /** The remove dialog: what removing this channel affects. Names come from the local index. */
  removalImpact(ctx: ModeCtx, client: DriveClient, id: string): Promise<RemovalImpact>;
  /** Node IDs of every file with a piece on the channel (the full list before "remove anyway"). */
  channelFileIds(ctx: ModeCtx, client: DriveClient, id: string): Promise<string[]>;
  /** Option 1 (and its undo): stop / resume sending new fragments to this channel. Refused for a critical channel. */
  retireChannel(ctx: ModeCtx, id: string, retired: boolean): Promise<void>;
  /**
   * Option 2: copy everything off this channel to the active ones, then remove it. metadata only: runs in this tab
   * (resumable, state in the local database; onProgress while it runs); e2ee/plain: starts a job on the instance and
   * returns at once (poll moveStatus). Refused when no other active channel exists.
   */
  moveChannel(ctx: ModeCtx, client: DriveClient, id: string, onProgress?: (s: MoveStatus) => void): Promise<MoveStatus>;
  /** The move in progress or the last one, null = none. */
  moveStatus(ctx: ModeCtx, client: DriveClient): Promise<MoveStatus | null>;
  /** Option 3: remove anyway (files with pieces only there become unavailable, nothing is deleted). Refused for a critical channel. */
  removeChannel(ctx: ModeCtx, id: string, client?: DriveClient): Promise<void>;
  /** e2ee/plain with an instance bot: read the files of a removed channel through the bot and move them to active channels. */
  recoverWithBot?(ctx: ModeCtx, client: DriveClient, id: string): Promise<MoveStatus>;
  /**
   * Uploads (= file versions; an upload is bound to exactly one version) that cannot be read now: a piece on a
   * channel no longer in the account, with the channel(s). Computed locally (metadata only: vault + piece locations
   * in the local index) or from the instance (e2ee/plain), never an operation in the log: pasting the same webhook
   * again makes them available at once on every device.
   */
  unavailable(ctx: ModeCtx, client: DriveClient): Promise<{ uploadId: string; webhookIds: string[] }[]>;
  /** Background upkeep in the main tab (metadata only: piece locations of older versions from their manifests). */
  upkeep?(ctx: ModeCtx, client: DriveClient): Promise<void>;
  /** Real bytes of the account on Discord (pieces incl. encryption overhead, manifests, snapshot objects); null = unknown. */
  discordUsage?(ctx: ModeCtx, client: DriveClient): Promise<number | null>;
  /** The rescue kit text (secret) of this account. */
  rescueKit(ctx: ModeCtx, client: DriveClient): Promise<string>;
  /** Account ID and key from a kit text; throws on a kit of another mode. */
  decodeKit(text: string): { accountId: string; key: string };
  /** Whether this mode needs the main tab to write snapshots (metadata only). */
  readonly clientSnapshots: boolean;
  /** What the instance does with plaintext (plain only): thumbnails, server search, server Range streaming. */
  readonly serverFeatures?: { thumbnails: boolean; search: boolean; streaming: boolean };
  /** One snapshot tick (metadata only); null when nothing to do. */
  snapshotTick?(ctx: ModeCtx, client: DriveClient, force: boolean): Promise<{ kind: string; written: string; toSeq: number } | null>;
  /** Attachment addresses of one file version, manifest first (share links, §3.7). */
  shareAttachments(ctx: ModeCtx, client: DriveClient, manifestRef: string): Promise<ShareAttachment[]>;
  /** plain only: server thumbnail, server search, server Range stream URL. */
  thumbnail?(ctx: ModeCtx, nodeId: string): Promise<Blob | null>;
  search?(ctx: ModeCtx, q: string): Promise<{ id: string; name: string; kind: "file" | "folder"; parentId: string | null; size: number | null }[]>;
  streamUrl?(ctx: ModeCtx, nodeId: string): Promise<string | null>;
  /** Trash + fragment cleanup (metadata only: this client deletes; e2ee/plain: the instance does). */
  cleanup(ctx: ModeCtx, client: DriveClient, c: CleanupCtx): ModeCleanup;
  /** Codec of the operation log (encrypted, or plain JSON in plain mode). */
  arbiter(ctx: ModeCtx): ArbiterApi;
}
