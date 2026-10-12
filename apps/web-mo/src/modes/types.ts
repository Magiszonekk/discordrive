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
  /** One snapshot tick (metadata only); null when nothing to do. */
  snapshotTick?(ctx: ModeCtx, client: DriveClient, force: boolean): Promise<{ kind: string; written: string; toSeq: number } | null>;
  /** Attachment addresses of one file version, manifest first (share links, §3.7). */
  shareAttachments(ctx: ModeCtx, client: DriveClient, manifestRef: string): Promise<ShareAttachment[]>;
  /** Codec of the operation log (encrypted, or plain JSON in plain mode). */
  arbiter(ctx: ModeCtx): ArbiterApi;
}
