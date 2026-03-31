// DiscorDrive v4 — Video streaming helper (main thread ↔ Service Worker)

import { exportKey } from "@discordrive/processing";
import { unwrapFEK } from "./crypto.js";
import { useAuthStore } from "../stores/auth.js";

export interface StreamFileInfo {
  fileId: string;
  mimeType: string;
  size: string; // BigInt as string from GraphQL
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
}

/**
 * Register the streaming Service Worker (idempotent).
 * Returns the active ServiceWorkerRegistration.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers not supported in this browser");
  }

  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) {
    await navigator.serviceWorker.register("/stream-sw.js");
  }

  return navigator.serviceWorker.ready;
}

/**
 * Register a file for streaming. Unwraps FEK, exports it,
 * and sends it to the Service Worker along with file metadata.
 */
export async function registerStream(file: StreamFileInfo): Promise<void> {
  const { masterKey, token } = useAuthStore.getState();
  if (!masterKey) throw new Error("Not authenticated");
  if (!token) throw new Error("No auth token");

  const fek = await unwrapFEK(masterKey, file.encryptedFEK, file.fekIv);
  const fekRaw = await exportKey(fek);

  const reg = await ensureServiceWorker();
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker not active");

  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const chunksAhead = parseInt(env.VITE_STREAM_CHUNKS_AHEAD ?? "3", 10);
  const chunksBehind = parseInt(env.VITE_STREAM_CHUNKS_BEHIND ?? "2", 10);

  sw.postMessage({
    type: "REGISTER_STREAM",
    fileId: file.fileId,
    token,
    fekRaw,
    chunkSize: file.chunkSize,
    chunkCount: file.chunkCount,
    totalSize: Number(file.size),
    mimeType: file.mimeType,
    chunksAhead,
    chunksBehind,
    apiBaseUrl: env.VITE_API_URL ?? "",
  });
}

/**
 * Unregister a stream and free its resources in the Service Worker.
 */
export async function unregisterStream(fileId: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sw = reg?.active;
  if (!sw) return;

  sw.postMessage({
    type: "UNREGISTER_STREAM",
    fileId,
  });
}

/**
 * Get the URL for the video element's src attribute.
 */
export function getStreamUrl(fileId: string): string {
  return `/sw-stream/${fileId}`;
}
