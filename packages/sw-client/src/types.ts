// @ddv4/sw-client — TypeScript types

/**
 * Options provided when registering a file with the decryption proxy.
 *
 * The caller is responsible for unwrapping the FEK and exporting it to raw
 * bytes before calling registerFile(). This keeps @ddv4/sw-client fully
 * decoupled from any key management strategy.
 *
 * Example:
 *   const fek = await unwrapKey(...)
 *   const fekRaw = await crypto.subtle.exportKey("raw", fek)
 *   const handle = await client.registerFile({ fekRaw, ... })
 */
export interface FileRegistration {
  /** Raw AES-256-GCM key bytes (32 bytes). */
  fekRaw: ArrayBuffer;

  /**
   * URL template for fetching encrypted chunks.
   * Must contain the literal string `{index}` which the SW replaces at runtime.
   *
   * Examples:
   *   "/api/download/abc123/chunk/{index}"   — authenticated
   *   "/api/share/tok456/chunk/{index}"      — public share link
   */
  chunkUrlTemplate: string;

  /**
   * Headers to send with every chunk fetch request.
   * Pass { Authorization: "Bearer ..." } for authenticated endpoints.
   * Omit or pass {} for public endpoints.
   */
  headers?: Record<string, string>;

  /** Size of each decrypted chunk in bytes. */
  chunkSize: number;

  /** Total number of chunks. */
  chunkCount: number;

  /** Total decrypted file size in bytes (used for Content-Length and Range math). */
  totalSize: number;

  /** MIME type for Content-Type header (e.g. "video/mp4", "image/png", "application/pdf"). */
  mimeType: string;

  /** Original file name. Used for Content-Disposition when ?download=1. */
  fileName?: string;

  /** Number of chunks to prefetch ahead of the current read position. Default: 3. */
  chunksAhead?: number;

  /** Number of chunks to keep cached behind current position before eviction. Default: 2. */
  chunksBehind?: number;
}

/**
 * Handle returned by registerFile(). Contains the proxy URL and cleanup method.
 */
export interface FileHandle {
  /** Client-generated registration ID (UUID). */
  id: string;

  /**
   * URL for streaming access — use in <video src>, <img src>, fetch(), etc.
   * Format: /ddv4-file/<id>
   */
  url: string;

  /**
   * URL that triggers a browser file download.
   * The SW adds Content-Disposition: attachment; filename="<fileName>".
   * Format: /ddv4-file/<id>?download=1
   */
  downloadUrl: string;

  /** Unregister this file and free SW resources. */
  unregister: () => Promise<void>;
}

export interface Ddv4ClientOptions {
  /** Path to the ddv4-sw.js file served from the app origin. Default: "/ddv4-sw.js". */
  swPath?: string;

  /** Scope for the SW registration. Default: "/". */
  swScope?: string;
}
