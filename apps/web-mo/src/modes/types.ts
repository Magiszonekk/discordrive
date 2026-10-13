// What a mode adds to the browser app core (docs/stage3-modes.md §2). app-core.ts imports
// `ddn:mode`; the build (build.ts, esbuild plugin) resolves it to ONE of the files next to
// this one, so the code of the other modes is not even parsed into the bundle:
//   metadata-only.ts  webhook vault, posts straight to Discord, client snapshots
//   e2ee.ts           blobs through the instance, channels on the server, server snapshots
//   plain.ts          e2ee + operations in clear for the server (thumbnails, search)
// For typechecking, tsconfig maps `ddn:mode` to metadata-only.ts; every mode file is checked
// against ModeImpl below.

import type { IndexStore } from "@ddv4/sync-core";
import type { AccountKey, ArbiterApi, DriveClient, HttpApi, ShareAttachment } from "@ddv4/metadata-client";

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
}

export interface ChannelsView {
  /** Channels this account posts to that it added itself. */
  webhooks: { id: string; channelId: string; label: string; alive?: boolean }[];
  advice: { ok: boolean; channels: number; suggestMore: boolean; sharedChannels: string[] };
  /** e2ee/plain: the instance pool (count only; the URLs never leave the server). */
  pool?: { channels: number; alive: number };
  using?: "own" | "pool" | "none";
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
  channels(ctx: ModeCtx): Promise<ChannelsView>;
  addChannel(ctx: ModeCtx, url: string): Promise<void>;
  removeChannel?(ctx: ModeCtx, id: string): Promise<void>;
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
