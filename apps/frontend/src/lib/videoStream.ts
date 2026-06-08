import { fetchBlobBody } from "./api.js";
import { unwrapRootFek, decryptManifest, toBase64 } from "./crypto.js";
import { deriveFileContentKey } from "@ddv4/processing";
import { useAuthStore } from "../stores/auth.js";

const CRYPTO_OVERHEAD = 12 + 16; // AES-GCM: 12-byte IV + 16-byte auth tag

export interface StreamFileInfo {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: string;
  chunkSize: number;
  chunkCount: number;
  wrappedFEK: string;
  manifestBlobId: string;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers not supported in this browser");
  }

  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) {
    await navigator.serviceWorker.register("/stream-sw.js");
  }

  const reg = await navigator.serviceWorker.ready;

  // SW must control this page before fetch events are intercepted.
  // On first install or SW update, wait for controllerchange or SW_ACTIVATED message.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        navigator.serviceWorker.removeEventListener("message", onMessage);
        reject(new Error("Service Worker did not claim this page. Please refresh and try again."));
      }, 8000);

      const cleanup = () => {
        clearTimeout(t);
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        navigator.serviceWorker.removeEventListener("message", onMessage);
      };

      const onControllerChange = () => { cleanup(); resolve(); };
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type === "SW_ACTIVATED") { cleanup(); resolve(); }
      };

      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      navigator.serviceWorker.addEventListener("message", onMessage);
    });
  }

  return reg;
}

export async function registerStream(file: StreamFileInfo): Promise<void> {
  const { token, filesKey } = useAuthStore.getState();
  if (!filesKey) throw new Error("Not authenticated");

  const reg = await ensureServiceWorker();
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker not active");

  const rootFek = await unwrapRootFek(filesKey, file.wrappedFEK);

  const manifestBody = await fetchBlobBody(file.manifestBlobId);
  const manifest = await decryptManifest(rootFek, toBase64(new Uint8Array(manifestBody)));

  const contentKey = await deriveFileContentKey(rootFek);
  const fekRaw = await crypto.subtle.exportKey("raw", contentKey);

  const sortedChunks = manifest.chunks.slice().sort((a, b) => a.index - b.index);
  const blobIds = sortedChunks.map((c) => c.blobId);
  const lastChunk = sortedChunks[sortedChunks.length - 1];
  const totalSize = lastChunk
    ? (sortedChunks.length - 1) * manifest.chunkSizeBytes +
      Math.max(0, lastChunk.ciphertextSizeBytes - CRYPTO_OVERHEAD)
    : 0;

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();

    const timeoutHandle = setTimeout(() => {
      channel.port1.close();
      reject(new Error("SW stream registration timed out"));
    }, 5000);

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timeoutHandle);
      channel.port1.close();
      if (event.data?.type === "STREAM_REGISTERED") {
        resolve();
      } else {
        reject(new Error(event.data?.error ?? "Stream registration failed"));
      }
    };

    sw.postMessage(
      {
        type: "REGISTER_STREAM",
        fileId: file.fileId,
        fekRaw,
        blobIds,
        chunkSize: manifest.chunkSizeBytes,
        chunkCount: manifest.chunks.length,
        totalSize,
        mimeType: file.mimeType,
        chunksAhead: 3,
        chunksBehind: 1,
        token: token ?? "",
        apiBaseUrl: "",
      },
      [channel.port2],
    );
  });
}

export async function unregisterStream(fileId: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sw = reg?.active;
  if (!sw) return;

  sw.postMessage({
    type: "UNREGISTER_STREAM",
    fileId,
  });
}

export function getStreamUrl(fileId: string): string {
  return `/sw-stream/${fileId}`;
}
