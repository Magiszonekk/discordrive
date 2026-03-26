// DiscorDrive v4 — Upload Engine
// Universal upload logic: AES-GCM encryption, concurrent chunk upload,
// progress reporting. Works in both browser (Service Worker) and Node.js.

import { config } from "@ddv4/config";
import type { ChunkSink, UploadConfig, UploadProgress } from "./types.js";

const IV_LENGTH = config.ivLength;

export class UploadEngine {
  /**
   * Encrypt and upload pre-chunked data with concurrency control.
   * Chunks are Uint8Array[] — caller handles chunking (chunkFileStream, Buffer.subarray, etc.).
   */
  async uploadChunks(
    fileId: string,
    chunks: Uint8Array[],
    cfg: UploadConfig,
    sink: ChunkSink,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    const totalChunks = chunks.length;
    const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    let uploadedChunks = 0;
    let bytesUploaded = 0;

    const tasks = chunks.map((chunk, index) => async () => {
      const encrypted = await this.encrypt(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
        cfg.fek,
      );
      await sink.upload(fileId, index, encrypted);

      uploadedChunks++;
      bytesUploaded += chunk.byteLength;
      onProgress?.({
        chunkIndex: index,
        uploadedChunks,
        totalChunks,
        bytesUploaded,
        totalBytes,
      });
    });

    await this.runPool(tasks, cfg.concurrency);
  }

  /**
   * Encrypt and upload from an async iterable (streaming, no full buffer needed).
   * Accepts output from chunkFileStream() or similar generators.
   */
  async uploadStream(
    fileId: string,
    chunks: AsyncIterable<{ index: number; data: Uint8Array }>,
    totalChunks: number,
    cfg: UploadConfig,
    sink: ChunkSink,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    let uploadedChunks = 0;
    let bytesUploaded = 0;
    const queue: Promise<void>[] = [];

    for await (const { index, data } of chunks) {
      // Concurrency control — wait if queue is full
      if (queue.length >= cfg.concurrency) {
        await Promise.race(queue);
      }

      const chunkBytes = data.byteLength;
      const chunkPromise = (async () => {
        const encrypted = await this.encrypt(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
          cfg.fek,
        );
        await sink.upload(fileId, index, encrypted);

        uploadedChunks++;
        bytesUploaded += chunkBytes;
        onProgress?.({
          chunkIndex: index,
          uploadedChunks,
          totalChunks,
          bytesUploaded,
          totalBytes: 0, // Unknown when streaming
        });
      })();

      const tracked = chunkPromise.finally(() => {
        const idx = queue.indexOf(tracked);
        if (idx !== -1) queue.splice(idx, 1);
      });
      queue.push(tracked);
    }

    // Wait for remaining uploads
    await Promise.all(queue);
  }

  private async encrypt(chunk: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      fek,
      chunk,
    );

    // Output format: [12B IV | ciphertext (includes 16B auth tag)]
    const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    output.set(iv, 0);
    output.set(new Uint8Array(ciphertext), iv.byteLength);
    return output.buffer as ArrayBuffer;
  }

  private async runPool<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
  ): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIdx = 0;

    async function worker() {
      while (true) {
        const idx = nextIdx;
        if (idx >= tasks.length) break;
        nextIdx++;
        results[idx] = await tasks[idx]();
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
    );
    return results;
  }
}
