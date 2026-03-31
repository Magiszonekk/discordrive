// DiscorDrive v4 — Upload via Service Worker
// Sends File object to SW which streams it chunk by chunk, encrypts, and uploads.
// RAM usage: O(concurrency × chunkSize) regardless of file size.

import { calculateChunkCount, exportKey } from "@discordrive/processing";
import { config } from "@discordrive/config";
import { ensureServiceWorker } from "./videoStream.js";
import { useAuthStore } from "../stores/auth.js";
import type { UploadProgress } from "@discordrive/stream-engine";

/**
 * Upload a file through the Service Worker (streaming mode).
 * Main thread sends the File object — SW reads it chunk by chunk.
 * SW encrypts and uploads each chunk with concurrency control.
 *
 * Caller is responsible for: hashing, initUpload, finalizeUpload (GraphQL).
 */
export async function uploadViaSW(
  file: File,
  fileId: string,
  fek: CryptoKey,
  chunkSize: number = config.defaultChunkSize,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reg = await ensureServiceWorker();
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker not active");

  const { token } = useAuthStore.getState();
  if (!token) throw new Error("No auth token");

  const fekRaw = await exportKey(fek);
  const totalChunks = calculateChunkCount(file.size, chunkSize);

  return new Promise<void>((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.fileId !== fileId) return;

      if (msg.type === "UPLOAD_PROGRESS") {
        onProgress?.(msg as UploadProgress);
      }
      if (msg.type === "UPLOAD_DONE") {
        cleanup();
        resolve();
      }
      if (msg.type === "UPLOAD_ERROR") {
        cleanup();
        reject(new Error(msg.error));
      }
      if (msg.type === "UPLOAD_CANCELLED") {
        cleanup();
        reject(new DOMException("Upload cancelled", "AbortError"));
      }
    };

    const onAbort = () => {
      sw.postMessage({ type: "CANCEL_UPLOAD", fileId });
    };

    const cleanup = () => {
      navigator.serviceWorker.removeEventListener("message", handler);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort);
    navigator.serviceWorker.addEventListener("message", handler);

    // Send File object (structured clone — lazy reference, no data copy)
    // Transfer fekRaw buffer (zero-copy ownership transfer)
    sw.postMessage(
      {
        type: "UPLOAD_FILE",
        fileId,
        file,
        fekRaw,
        token,
        chunkSize,
        totalChunks,
        concurrency: config.defaultUploadConcurrency,
        maxRetries: 5,
        apiBaseUrl: import.meta.env.VITE_API_URL ?? "",
      },
      [fekRaw as ArrayBuffer],
    );
  });
}
