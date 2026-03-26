// DiscorDrive v4 — Download pipeline
// Single-file downloads use the SW decryption proxy (streaming, no memory buffering).
// Folder ZIP downloads still use the in-memory approach via JSZip.

import JSZip from "jszip";
import { decryptChunk, exportKey } from "@ddv4/processing";
import { downloadChunkFromApi, downloadSharedChunk } from "./api.js";
import { unwrapFEK } from "./crypto.js";
import { useAuthStore } from "../stores/auth.js";
import { ddv4 } from "./swClient.js";

interface DownloadOptions {
  fileId: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  totalSize: number;
  encryptedFEK: string;
  fekIv: string;
}

interface SharedDownloadOptions {
  token: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  totalSize: number;
  fek: CryptoKey;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { masterKey, token } = useAuthStore.getState();
  if (!masterKey) throw new Error("Not authenticated");
  if (!token) throw new Error("No auth token");

  if ("serviceWorker" in navigator) {
    // SW path: streaming download — no memory buffering
    const fek = await unwrapFEK(masterKey, options.encryptedFEK, options.fekIv);
    const fekRaw = await exportKey(fek);

    const handle = await ddv4.registerFile({
      fekRaw,
      chunkUrlTemplate: `/api/download/${options.fileId}/chunk/{index}`,
      headers: { Authorization: `Bearer ${token}` },
      chunkSize: options.chunkSize,
      chunkCount: options.chunkCount,
      totalSize: options.totalSize,
      mimeType: options.mimeType,
      fileName: options.fileName,
    });

    triggerDownload(handle.downloadUrl, options.fileName);
    // Keep registered — SW streams chunks while browser downloads.
    // The handle is not tracked here; it stays alive until page unload.
  } else {
    // Fallback: buffer all chunks in main thread
    const fek = await unwrapFEK(masterKey, options.encryptedFEK, options.fekIv);
    await bufferAndDownload({
      fileName: options.fileName,
      mimeType: options.mimeType,
      chunkCount: options.chunkCount,
      fek,
      fetchChunk: (i) => downloadChunkFromApi(options.fileId, i),
    });
  }
}

export async function downloadSharedFile(
  options: SharedDownloadOptions,
): Promise<void> {
  if ("serviceWorker" in navigator) {
    const fekRaw = await exportKey(options.fek);

    const handle = await ddv4.registerFile({
      fekRaw,
      chunkUrlTemplate: `/api/share/${options.token}/chunk/{index}`,
      headers: {},
      chunkSize: options.chunkSize,
      chunkCount: options.chunkCount,
      totalSize: options.totalSize,
      mimeType: options.mimeType,
      fileName: options.fileName,
    });

    triggerDownload(handle.downloadUrl, options.fileName);
  } else {
    await bufferAndDownload({
      fileName: options.fileName,
      mimeType: options.mimeType,
      chunkCount: options.chunkCount,
      fek: options.fek,
      fetchChunk: (i) => downloadSharedChunk(options.token, i),
    });
  }
}

function triggerDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function bufferAndDownload(params: {
  fileName: string;
  mimeType: string;
  chunkCount: number;
  fek: CryptoKey;
  fetchChunk: (index: number) => Promise<ArrayBuffer>;
}): Promise<void> {
  const { fileName, mimeType, chunkCount, fek, fetchChunk } = params;
  const chunks: ArrayBuffer[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const encrypted = await fetchChunk(i);
    const decrypted = await decryptChunk(encrypted, fek);
    chunks.push(decrypted);
  }

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, fileName);
  URL.revokeObjectURL(url);
}

// === Folder ZIP download (always in-memory — must combine multiple files) ===

interface ZipFileItem {
  fileId: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
}

export async function downloadFolderAsZip(
  folderName: string,
  files: ZipFileItem[],
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const masterKey = useAuthStore.getState().masterKey;
  if (!masterKey) throw new Error("Not authenticated");

  const zip = new JSZip();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fek = await unwrapFEK(masterKey, file.encryptedFEK, file.fekIv);

    const chunks: ArrayBuffer[] = [];
    for (let j = 0; j < file.chunkCount; j++) {
      const encrypted = await downloadChunkFromApi(file.fileId, j);
      const decrypted = await decryptChunk(encrypted, fek);
      chunks.push(decrypted);
    }

    const blob = new Blob(chunks, { type: file.mimeType });
    zip.file(file.fileName, blob);

    onProgress?.(i + 1, files.length);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  triggerDownload(url, `${folderName}.zip`);
  URL.revokeObjectURL(url);
}
