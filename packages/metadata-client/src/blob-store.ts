// Where encrypted blobs (fragments, manifests) go: the seam between the
// client core (DriveClient: index, log, encryption, manifests) and the mode.
//
//   metadata only  BackendBlobStore (backends.ts): straight to the user's
//                  backends from the vault (Discord webhooks), paced on the device.
//   e2ee / plain   ServerBlobStore (server-blobs.ts): to the instance, which
//                  posts on Discord with its own webhooks (stage 3).
//
// The bytes are the same in every mode (discordrive fragment format); only
// the transport differs. A mode bundle imports one implementation only.

import type { ExtraFile, Placement } from "./types.js";
import type { TransferLog } from "./transfer-log.js";
import type { NetControl } from "./net.js";

export interface BlobPutContext {
  /** Upload the blob belongs to (fragments and the manifest of one version). */
  uploadId?: string;
  /** Fragment index, "m" for the manifest, `x<name>` for an extra blob next to it (instance only). */
  index?: number | "m" | `x${string}`;
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

/** Extra blobs stored next to another one (previews next to a manifest): name, size, where. */
export interface ExtraPlacement {
  /** The name it was stored under, without the extension. */
  name: string;
  size: number;
  placement: Placement;
}

export interface BlobStore {
  put(data: Uint8Array, filename: string, ctx?: BlobPutContext): Promise<Placement>;
  /**
   * Store a blob together with small extra blobs that belong to it (previews next to a manifest). Discord:
   * one message with several attachments; the instance: blobs of the same upload. A store without it
   * (or a backend that cannot) stores only the main blob: callers treat the extras as optional.
   */
  putWithExtras?(data: Uint8Array, filename: string, extras: ExtraFile[], ctx?: BlobPutContext): Promise<{ placement: Placement; extras: ExtraPlacement[] }>;
  /** The extra blobs stored next to `p` (Discord: the other attachments of its message). */
  extrasOf?(p: Placement, signal?: AbortSignal): Promise<ExtraPlacement[]>;
  /** Add extra blobs next to `p` later (existing ones stay). */
  addExtras?(p: Placement, extras: ExtraFile[], ctx?: { uploadId?: string }): Promise<ExtraPlacement[]>;
  get(p: Placement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array>;
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
  prefetch?(ps: Placement[], ctx?: { x?: string; first?: number }): Promise<void>;
  /** All blobs of the upload are stored; about to commit (the server stops treating it as abandoned). */
  finalize?(uploadId: string, o?: { outsideLog?: boolean }): Promise<void>;
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
