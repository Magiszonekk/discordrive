import { fetchBlobBody, fetchBlobBodyShared } from "./api.js";
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

  // Register listeners synchronously before any await so we cannot miss
  // controllerchange or SW_ACTIVATED that fires during the async steps below.
  let claimResolve: (() => void) | undefined;
  let claimReject: ((e: Error) => void) | undefined;
  const claimPromise = new Promise<void>((res, rej) => {
    claimResolve = res;
    claimReject = rej;
  });

  const t = setTimeout(() => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.removeEventListener("message", onMessage);
    claimReject!(new Error("Service Worker did not claim this page. Please refresh and try again."));
  }, 10_000);

  const cleanup = () => {
    clearTimeout(t);
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.removeEventListener("message", onMessage);
  };

  const onControllerChange = () => { cleanup(); claimResolve!(); };
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === "SW_ACTIVATED") { cleanup(); claimResolve!(); }
  };

  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  navigator.serviceWorker.addEventListener("message", onMessage);

  // Always register (idempotent; triggers update check when SW file changes).
  await navigator.serviceWorker.register("/stream-sw.js");
  const reg = await navigator.serviceWorker.ready;

  if (navigator.serviceWorker.controller) {
    cleanup();
    return reg;
  }

  // SW is active but hasn't claimed this page. Ask it to claim now (handles
  // the case where the initial controllerchange was missed on first install).
  reg.active?.postMessage({ type: "CLAIM" });

  await claimPromise;
  return reg;
}

/**
 * Share-link credentials: no logged-in account, the viewer only ever proves
 * possession of one file's capability token (derived from the URL fragment
 * secret in SharedFile.tsx). Passing `share` skips the owner auth path
 * entirely — mirrors fetchBlobBodyShared() vs fetchBlobBody() on the main
 * thread, and is exactly what downloadSharedFile() already does for the
 * non-streaming download path.
 */
export interface ShareStreamAuth {
  shareId: string;
  capabilityToken: string;
  /** Already-unwrapped file key — a share viewer has no account filesKey to
   *  unwrap file.wrappedFEK with, so the caller (SharedFile.tsx) derives this
   *  via the share-specific key chain and hands it over directly. */
  rootFek: CryptoKey;
}

export async function registerStream(file: StreamFileInfo, share?: ShareStreamAuth): Promise<void> {
  const reg = await ensureServiceWorker();
  const sw = reg.active;
  if (!sw) throw new Error("Service Worker not active");

  let rootFek: CryptoKey;
  let manifestBody: ArrayBuffer;
  let token = "";

  if (share) {
    rootFek = share.rootFek;
    manifestBody = await fetchBlobBodyShared(file.manifestBlobId, share.shareId, share.capabilityToken);
  } else {
    const { token: ownerToken, filesKey } = useAuthStore.getState();
    if (!filesKey) throw new Error("Not authenticated");
    token = ownerToken ?? "";
    rootFek = await unwrapRootFek(filesKey, file.wrappedFEK);
    manifestBody = await fetchBlobBody(file.manifestBlobId);
  }

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
        ...(share
          ? { shareId: share.shareId, capabilityToken: share.capabilityToken }
          : { token }),
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
