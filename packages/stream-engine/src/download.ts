// DiscorDrive v4 — Download Engine
// Universal download logic: chunk fetching, AES-GCM decryption,
// caching with prefetch/eviction, byte-range assembly, full streaming.
// Works in both browser (Service Worker) and Node.js (benchmark/CLI).

import { config } from "@discordrive/config";
import type { StreamConfig, ChunkSource } from "./types.js";

const IV_LENGTH = config.ivLength;

export class DownloadEngine {
  private streams = new Map<string, StreamConfig>();
  private chunkCache = new Map<string, Map<number, ArrayBuffer>>();
  private fetching = new Map<string, Map<number, Promise<ArrayBuffer>>>();

  // === Registration ===

  register(cfg: StreamConfig): void {
    this.streams.set(cfg.fileId, cfg);
    this.chunkCache.set(cfg.fileId, new Map());
    this.fetching.set(cfg.fileId, new Map());
  }

  unregister(fileId: string): void {
    this.streams.delete(fileId);
    this.chunkCache.delete(fileId);
    this.fetching.delete(fileId);
  }

  getConfig(fileId: string): StreamConfig | undefined {
    return this.streams.get(fileId);
  }

  // === Public API ===

  /**
   * Get a single decrypted chunk (cache-first, dedup in-flight requests).
   */
  async getDecryptedChunk(
    fileId: string,
    chunkIndex: number,
    source: ChunkSource,
  ): Promise<ArrayBuffer> {
    const cache = this.chunkCache.get(fileId);
    if (cache?.has(chunkIndex)) {
      return cache.get(chunkIndex)!;
    }

    // Deduplicate concurrent fetches for the same chunk
    const inflight = this.fetching.get(fileId);
    if (inflight?.has(chunkIndex)) {
      return inflight.get(chunkIndex)!;
    }

    const stream = this.streams.get(fileId);
    if (!stream) throw new Error(`Stream ${fileId} not registered`);

    const promise = this.fetchAndDecrypt(fileId, stream, chunkIndex, source);
    inflight?.set(chunkIndex, promise);

    try {
      const decrypted = await promise;
      cache?.set(chunkIndex, decrypted);
      return decrypted;
    } finally {
      inflight?.delete(chunkIndex);
    }
  }

  /**
   * Assemble a byte range from one or more decrypted chunks.
   * Handles single-chunk fast path and multi-chunk assembly.
   * Triggers prefetch/eviction as side effects.
   */
  async getByteRange(
    fileId: string,
    start: number,
    end: number,
    source: ChunkSource,
  ): Promise<ArrayBuffer> {
    const stream = this.streams.get(fileId);
    if (!stream) throw new Error(`Stream ${fileId} not registered`);

    const { chunkSize } = stream;
    const startChunk = Math.floor(start / chunkSize);
    const endChunk = Math.floor(end / chunkSize);
    const totalBytes = end - start + 1;

    // Schedule prefetch/eviction based on current position
    this.schedulePrefetch(fileId, startChunk, source);
    this.scheduleEviction(fileId, startChunk);

    if (startChunk === endChunk) {
      // Single chunk — fast path
      const decrypted = await this.getDecryptedChunk(fileId, startChunk, source);
      const offsetInChunk = start - startChunk * chunkSize;
      return decrypted.slice(offsetInChunk, offsetInChunk + totalBytes);
    }

    // Multiple chunks — assemble
    const result = new Uint8Array(totalBytes);
    let written = 0;

    for (let ci = startChunk; ci <= endChunk; ci++) {
      const decrypted = await this.getDecryptedChunk(fileId, ci, source);
      const chunkStart = ci * chunkSize;

      const sliceStart = Math.max(start, chunkStart) - chunkStart;
      const sliceEnd = Math.min(end + 1, chunkStart + decrypted.byteLength) - chunkStart;
      const slice = new Uint8Array(decrypted, sliceStart, sliceEnd - sliceStart);

      result.set(slice, written);
      written += slice.byteLength;
    }

    return result.buffer as ArrayBuffer;
  }

  /**
   * Create a full ReadableStream of all decrypted chunks (sequential).
   * Used for initial codec detection by <video> elements and full file downloads.
   */
  createFullStream(fileId: string, source: ChunkSource): ReadableStream<Uint8Array> {
    const stream = this.streams.get(fileId);
    if (!stream) throw new Error(`Stream ${fileId} not registered`);

    const { chunkCount } = stream;
    let currentChunk = 0;
    let cancelled = false;

    return new ReadableStream({
      pull: async (controller) => {
        if (cancelled || currentChunk >= chunkCount) {
          controller.close();
          return;
        }
        try {
          const decrypted = await this.getDecryptedChunk(fileId, currentChunk, source);
          controller.enqueue(new Uint8Array(decrypted));
          currentChunk++;
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: () => {
        cancelled = true;
      },
    });
  }

  /**
   * Download all chunks sequentially, decrypt, return as array.
   * Useful for full file downloads and benchmarks.
   */
  async downloadAll(fileId: string, source: ChunkSource): Promise<ArrayBuffer[]> {
    const stream = this.streams.get(fileId);
    if (!stream) throw new Error(`Stream ${fileId} not registered`);

    const results: ArrayBuffer[] = [];
    for (let i = 0; i < stream.chunkCount; i++) {
      results.push(await this.getDecryptedChunk(fileId, i, source));
    }
    return results;
  }

  // === Internal ===

  private async fetchAndDecrypt(
    fileId: string,
    stream: StreamConfig,
    chunkIndex: number,
    source: ChunkSource,
  ): Promise<ArrayBuffer> {
    const encrypted = await source.fetch(fileId, chunkIndex);
    return this.decrypt(encrypted, stream.fek);
  }

  private async decrypt(encrypted: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer> {
    const data = new Uint8Array(encrypted);
    const iv = data.subarray(0, IV_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, fek, ciphertext);
  }

  private schedulePrefetch(fileId: string, currentChunk: number, source: ChunkSource): void {
    const stream = this.streams.get(fileId);
    if (!stream) return;

    const { chunkCount, chunksAhead } = stream;
    const limit = Math.min(currentChunk + chunksAhead + 1, chunkCount);

    for (let ci = currentChunk + 1; ci < limit; ci++) {
      const cache = this.chunkCache.get(fileId);
      const inflight = this.fetching.get(fileId);
      if (cache && !cache.has(ci) && inflight && !inflight.has(ci)) {
        // Fire and forget — prefetch in background
        this.getDecryptedChunk(fileId, ci, source).catch(() => {});
      }
    }
  }

  private scheduleEviction(fileId: string, currentChunk: number): void {
    const stream = this.streams.get(fileId);
    if (!stream) return;

    const cache = this.chunkCache.get(fileId);
    if (!cache) return;

    const evictBefore = currentChunk - stream.chunksBehind;
    for (const key of cache.keys()) {
      if (key < evictBefore) {
        cache.delete(key);
      }
    }
  }
}
