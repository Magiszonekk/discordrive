// DiscorDrive v4 — Upload via Service Worker
// Sends chunks to the SW which encrypts and uploads them with concurrency control.
// The SW continues working even if the user navigates away.

import { chunkFileStream, exportKey } from "@ddv4/processing";
import { config } from "@ddv4/config";
import { ensureServiceWorker } from "./videoStream.js";
import { useAuthStore } from "../stores/auth.js";
import type { UploadProgress } from "@ddv4/stream-engine";

/**
 * Upload a file through the Service Worker.
 * Main thread chunks the file and transfers ArrayBuffers to SW.
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
): Promise<void> {
  const reg = await ensureServiceWorker();
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker not active");

  const { token } = useAuthStore.getState();
  if (!token) throw new Error("No auth token");

  const fekRaw = await exportKey(fek);

  // Chunk file in main thread, collect transferable ArrayBuffers
  const chunks: ArrayBuffer[] = [];
  for await (const { data } of chunkFileStream(file, chunkSize)) {
    chunks.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  }

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
    };

    const cleanup = () => {
      navigator.serviceWorker.removeEventListener("message", handler);
    };

    navigator.serviceWorker.addEventListener("message", handler);

    // Transfer ArrayBuffers to SW (zero-copy)
    sw.postMessage(
      {
        type: "UPLOAD_CHUNKS",
        fileId,
        fekRaw,
        token,
        chunks,
        chunkSize,
        concurrency: config.defaultUploadConcurrency,
      },
      chunks,
    );
  });
}
