// DiscorDrive v4 — Download helpers for secure files v2

import { zipSync } from "fflate";
import { fetchBlobBody, fetchBlobBodyShared, fetchBlobDescriptor } from "./api.js";
import { decryptManifest, decryptFileContentChunk, decryptMeta, fromBase64, unwrapRootFek, toBase64, unwrapFolderKey, decryptFolderBody } from "./crypto.js";
import { gqlRequest } from "./graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { useDownloadStore } from "../stores/download.js";
import { DownloadStatus } from "@ddv4/types";

export const DOWNLOAD_SUCCESS_EVENT = "ddv4:download-started";

interface DownloadOptions {
  fileId: string;
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  wrappedFEK: string;
}

interface SharedDownloadOptions {
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  rootFek: CryptoKey;
  shareId?: string;
  capabilityToken?: string;
}

interface DownloadResult {
  fileName: string;
  bytes: number;
}

function emitDownloadStarted(detail: DownloadResult) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DOWNLOAD_SUCCESS_EVENT, { detail }));
  }
}

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const filesKey = useAuthStore.getState().filesKey;
  if (!filesKey) throw new Error("Not authenticated");

  const downloadStore = useDownloadStore.getState();
  const controller = new AbortController();
  downloadStore.registerController(options.fileId, controller);

  // Emit download started immediately so UI can show progress
  emitDownloadStarted({ fileName: options.fileName, bytes: 0 });

  try {
    const rootFek = await unwrapRootFek(filesKey, options.wrappedFEK);
    downloadStore.updateDownload(options.fileId, { status: DownloadStatus.DECRYPTING });

    const manifestDescriptor = await fetchBlobDescriptor(options.manifestBlobId);
    const manifestBody = await fetchBlobBody(manifestDescriptor.blobId, controller.signal);
    const manifest = await decryptManifest(rootFek, toBase64(new Uint8Array(manifestBody)));

    downloadStore.updateDownload(options.fileId, {
      status: DownloadStatus.DOWNLOADING,
      totalChunks: manifest.chunks.length,
    });

    const sortedChunks = manifest.chunks.slice().sort((a, b) => a.index - b.index);
    const chunkCount = sortedChunks.length;
    const chunks: ArrayBuffer[] = new Array(chunkCount);
    let downloadedBytes = 0;
    let downloadedChunks = 0;
    const DOWNLOAD_CONCURRENCY = 20;
    const CHUNK_TIMEOUT_MS = 60_000;
    const MAX_CHUNK_RETRIES = 2;

    const fetchChunkWithTimeout = async (blobId: string): Promise<ArrayBuffer> => {
      for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        if (controller.signal.aborted) throw new DOMException("Download aborted", "AbortError");
        const timeoutSignal = AbortSignal.timeout(CHUNK_TIMEOUT_MS);
        const signal = AbortSignal.any([controller.signal, timeoutSignal]);
        try {
          return await fetchBlobBody(blobId, signal);
        } catch (err) {
          const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
          if (isTimeout && !controller.signal.aborted && attempt < MAX_CHUNK_RETRIES) continue;
          throw err;
        }
      }
      throw new Error(`Chunk ${blobId} failed after ${MAX_CHUNK_RETRIES} retries`);
    };

    let cursor = 0;
    const downloadWorker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= chunkCount) break;
        const chunkBody = await fetchChunkWithTimeout(sortedChunks[i]!.blobId);
        const decrypted = await decryptFileContentChunk(rootFek, new Uint8Array(chunkBody));
        chunks[i] = decrypted;
        downloadedBytes += decrypted.byteLength;
        downloadedChunks += 1;
        downloadStore.updateDownload(options.fileId, {
          downloadedChunks,
          bytesDownloaded: downloadedBytes,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, chunkCount) }, downloadWorker));

    saveBlob(chunks, options.fileName, options.mimeType);
    downloadStore.updateDownload(options.fileId, { status: DownloadStatus.DONE });
    const result = {
      fileName: options.fileName,
      bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
    return result;
  } finally {
    // don't removeDownload here — let DownloadProgress auto-dismiss after 3s
  }
}

export async function downloadSharedFile(options: SharedDownloadOptions & { signal?: AbortSignal }): Promise<DownloadResult> {
  emitDownloadStarted({ fileName: options.fileName, bytes: 0 });

  const useShare = options.shareId && options.capabilityToken;
  const fetchFn = useShare
    ? (blobId: string, signal?: AbortSignal) =>
        fetchBlobBodyShared(blobId, options.shareId!, options.capabilityToken!, signal)
    : (blobId: string, signal?: AbortSignal) => fetchBlobBody(blobId, signal);

  const manifestBody = await fetchFn(options.manifestBlobId, options.signal);
  const manifest = await decryptManifest(options.rootFek, toBase64(new Uint8Array(manifestBody)));

  const sharedSortedChunks = manifest.chunks.slice().sort((a, b) => a.index - b.index);
  const sharedChunkCount = sharedSortedChunks.length;
  const chunks: ArrayBuffer[] = new Array(sharedChunkCount);
  const DOWNLOAD_CONCURRENCY = 20;
  const CHUNK_TIMEOUT_MS = 60_000;
  const MAX_CHUNK_RETRIES = 2;

  const fetchSharedChunkWithTimeout = async (blobId: string): Promise<ArrayBuffer> => {
    for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      if (options.signal?.aborted) throw new DOMException("Download aborted", "AbortError");
      const timeoutSignal = AbortSignal.timeout(CHUNK_TIMEOUT_MS);
      const combined = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      try {
        return await fetchFn(blobId, combined);
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (isTimeout && !options.signal?.aborted && attempt < MAX_CHUNK_RETRIES) continue;
        throw err;
      }
    }
    throw new Error(`Chunk ${blobId} failed after ${MAX_CHUNK_RETRIES} retries`);
  };

  let sharedCursor = 0;
  const sharedWorker = async () => {
    while (true) {
      const i = sharedCursor++;
      if (i >= sharedChunkCount) break;
      const chunkBody = await fetchSharedChunkWithTimeout(sharedSortedChunks[i]!.blobId);
      const decrypted = await decryptFileContentChunk(options.rootFek, new Uint8Array(chunkBody));
      chunks[i] = decrypted;
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, sharedChunkCount) }, sharedWorker));

  saveBlob(chunks, options.fileName, options.mimeType);
  const result = {
    fileName: options.fileName,
    bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  };
  return result;
}

// === Folder ZIP download ===

const FOLDER_TREE_QUERY = `
  query FolderTree($parentFolderId: ID) {
    files(parentFolderId: $parentFolderId) {
      id encryptedName primaryManifestBlobId wrappedFEK chunkCount status
    }
    folders(parentFolderId: $parentFolderId) {
      id encryptedBody wrappedFolderKey
    }
  }
`;

interface FolderTreeFile {
  id: string;
  encryptedName: string | null;
  primaryManifestBlobId: string | null;
  wrappedFEK: string;
  chunkCount: number;
  status: string;
}

interface FolderTreeFolder {
  id: string;
  encryptedBody: string;
  wrappedFolderKey: string;
}

async function collectZipEntries(
  filesKey: CryptoKey,
  parentFolderId: string | null,
  pathPrefix: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const result = await gqlRequest<{ files: FolderTreeFile[]; folders: FolderTreeFolder[] }>(
    FOLDER_TREE_QUERY,
    { parentFolderId },
  );

  for (const file of result.files.filter((f) => f.status === "READY" && f.primaryManifestBlobId)) {
    let fileName = file.id;
    try {
      const fek = await unwrapRootFek(filesKey, file.wrappedFEK);
      if (file.encryptedName) {
        fileName = await decryptMeta(fek, file.encryptedName);
      }

      const manifestBody = await fetchBlobBody(file.primaryManifestBlobId!);
      const manifest = await decryptManifest(fek, toBase64(new Uint8Array(manifestBody)));
      const sortedChunks = manifest.chunks.slice().sort((a, b) => a.index - b.index);

      const chunkBuffers = await Promise.all(
        sortedChunks.map((c) => fetchBlobBody(c.blobId).then((buf) => decryptFileContentChunk(fek, new Uint8Array(buf)))),
      );

      const totalBytes = chunkBuffers.reduce((sum, b) => sum + b.byteLength, 0);
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const buf of chunkBuffers) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }

      const zipPath = pathPrefix ? `${pathPrefix}/${fileName}` : fileName;
      entries[zipPath] = combined;
    } catch {
      // skip files that fail to decrypt
    }
  }

  for (const folder of result.folders) {
    let folderName = folder.id;
    try {
      const folderKey = await unwrapFolderKey(folder.wrappedFolderKey, filesKey);
      const body = await decryptFolderBody(folder.encryptedBody, folderKey);
      folderName = body.name;
    } catch { /* fallback to id */ }
    const subPath = pathPrefix ? `${pathPrefix}/${folderName}` : folderName;
    await collectZipEntries(filesKey, folder.id, subPath, entries);
  }
}

export async function downloadFolderAsZip(
  folderId: string,
  folderName: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const filesKey = useAuthStore.getState().filesKey;
  if (!filesKey) throw new Error("Not authenticated");

  onProgress?.("Collecting files…");
  const entries: Record<string, Uint8Array> = {};
  await collectZipEntries(filesKey, folderId, "", entries);

  if (Object.keys(entries).length === 0) {
    throw new Error("Folder is empty or all files failed to decrypt");
  }

  onProgress?.(`Packing ${Object.keys(entries).length} files…`);
  const zipped = zipSync(entries, { level: 0 });

  const blob = new Blob([zipped], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function saveBlob(chunks: ArrayBuffer[], fileName: string, mimeType: string) {
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.info("[ddv4] download-started", { fileName, bytes: blob.size });
  (window as unknown as { __ddv4DownloadSignal?: { fileName: string; bytes: number } }).__ddv4DownloadSignal = {
    fileName,
    bytes: blob.size,
  };
}
