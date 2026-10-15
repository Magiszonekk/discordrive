// Where encrypted blobs (fragments, manifests) go: the seam between the
// client core (DriveClient: index, log, encryption, manifests) and the mode.
//
//   metadata only  WebhookBlobStore (webhook-blobs.ts): straight to the user's
//                  webhooks from the vault, paced per channel on the device.
//   e2ee / plain   ServerBlobStore (server-blobs.ts): to the instance, which
//                  posts on Discord with its own webhooks (stage 3).
//
// The bytes are the same in every mode (discordrive fragment format); only
// the transport differs. A mode bundle imports one implementation only.

import type { DiscordPlacement } from "./types.js";
import type { TransferLog } from "./transfer-log.js";
import type { NetControl } from "./net.js";

export interface BlobPutContext {
  /** Upload the blob belongs to (fragments and the manifest of one version). */
  uploadId?: string;
  /** Fragment index, or "m" for the manifest. */
  index?: number | "m";
  /** Plaintext SHA-256 is not known here; this is the ciphertext hash (hex), when the caller has it. */
  sha256?: string;
  signal?: AbortSignal;
  /** Counts transport attempts (diagnostics: posts per upload). */
  stats?: { posts: number };
}

/** Which transfer a read belongs to (transfer logs only). */
export interface BlobGetContext {
  /** Upload ID of the version being read. */
  x?: string;
  /** Fragment index or "m" (manifest). */
  i?: number | "m";
}

export interface BlobStore {
  put(data: Uint8Array, filename: string, ctx?: BlobPutContext): Promise<DiscordPlacement>;
  get(p: DiscordPlacement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array>;
  /** Channels new blobs are spread over (DriveClient sizes the upload concurrency from it). */
  lanes?(): number;
  /** Transfer log (Settings → Diagnostics); null = off. Set by DriveClient.setTransferLog. */
  log?: TransferLog | null;
  /** Network state (gate, windows, stuck-connection guard). Set by DriveClient. */
  net?: NetControl | null;
  /** Extra connections for CDN reads (lane 1, 2, …; the page's own fetch is lane 0). */
  setCdnLanes?(lanes: LaneFetch[]): void;
  /**
   * Hint before reading many blobs in this order: fetch their fresh links ahead (metadata only: in the
   * background, while the current ones download; e2ee/plain: one batch refresh call). `x`/`first` name the
   * transfer and the index of the first one (logs only).
   */
  prefetch?(ps: DiscordPlacement[], ctx?: { x?: string; first?: number }): Promise<void>;
  /** All blobs of the upload are stored; about to commit (the server stops treating it as abandoned). */
  finalize?(uploadId: string): Promise<void>;
  /** The upload failed or was cancelled before finalize: drop its blobs (best effort). */
  abort?(uploadId: string): Promise<void>;
}

/** A fetch on another connection (web: a sandboxed iframe of this origin gets its own connection). */
export type LaneFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}
