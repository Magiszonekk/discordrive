// DiscorDrive v4 — Video streaming helper (main thread ↔ @ddv4/sw-client)
// Thin wrapper that bridges app-specific auth/crypto to the generic Ddv4Client.

import { exportKey } from "@ddv4/processing";
import type { FileHandle } from "@ddv4/sw-client";
import { unwrapFEK } from "./crypto.js";
import { useAuthStore } from "../stores/auth.js";
import { ddv4 } from "./swClient.js";

export interface StreamFileInfo {
  fileId: string;
  mimeType: string;
  size: string; // BigInt as string from GraphQL
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
}

// Track active handles by fileId for cleanup
const activeHandles = new Map<string, FileHandle>();

/**
 * Register a file for streaming. Unwraps FEK, exports raw bytes,
 * and registers with the decryption proxy SW.
 * Returns the FileHandle (use handle.url as <video src>).
 */
export async function registerStream(file: StreamFileInfo): Promise<FileHandle> {
  const { masterKey, token } = useAuthStore.getState();
  if (!masterKey) throw new Error("Not authenticated");
  if (!token) throw new Error("No auth token");

  const fek = await unwrapFEK(masterKey, file.encryptedFEK, file.fekIv);
  const fekRaw = await exportKey(fek);

  const handle = await ddv4.registerFile({
    fekRaw,
    chunkUrlTemplate: `/api/download/${file.fileId}/chunk/{index}`,
    headers: { Authorization: `Bearer ${token}` },
    chunkSize: file.chunkSize,
    chunkCount: file.chunkCount,
    totalSize: Number(file.size),
    mimeType: file.mimeType,
    chunksAhead: 3,
    chunksBehind: 2,
  });

  activeHandles.set(file.fileId, handle);
  return handle;
}

/**
 * Unregister a stream and free its resources in the Service Worker.
 */
export async function unregisterStream(fileId: string): Promise<void> {
  const handle = activeHandles.get(fileId);
  if (handle) {
    await handle.unregister();
    activeHandles.delete(fileId);
  }
}

/**
 * Get the streaming URL for a registered file.
 * Returns the handle URL if available, otherwise constructs a fallback URL.
 */
export function getStreamUrl(fileId: string): string {
  return activeHandles.get(fileId)?.url ?? `/ddv4-file/${fileId}`;
}
