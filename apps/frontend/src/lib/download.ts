// DiscorDrive v4 — Download pipeline (streaming)

import { decryptChunk } from "@discordrive/processing";
import { downloadChunkFromApi, downloadSharedChunk } from "./api.js";
import { unwrapFEK } from "./crypto.js";
import { useAuthStore } from "../stores/auth.js";

interface DownloadOptions {
  fileId: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
}

interface SharedDownloadOptions {
  token: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  fek: CryptoKey;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const masterKey = useAuthStore.getState().masterKey;
  if (!masterKey) throw new Error("Not authenticated");

  const fek = await unwrapFEK(masterKey, options.encryptedFEK, options.fekIv);
  await streamDownload({
    fileName: options.fileName,
    mimeType: options.mimeType,
    chunkCount: options.chunkCount,
    fek,
    fetchChunk: (index) => downloadChunkFromApi(options.fileId, index),
  });
}

export async function downloadSharedFile(
  options: SharedDownloadOptions,
): Promise<void> {
  await streamDownload({
    fileName: options.fileName,
    mimeType: options.mimeType,
    chunkCount: options.chunkCount,
    fek: options.fek,
    fetchChunk: (index) => downloadSharedChunk(options.token, index),
  });
}

async function streamDownload(params: {
  fileName: string;
  mimeType: string;
  chunkCount: number;
  fek: CryptoKey;
  fetchChunk: (index: number) => Promise<ArrayBuffer>;
}): Promise<void> {
  const { fileName, mimeType, chunkCount, fek, fetchChunk } = params;

  // Collect decrypted chunks
  const chunks: ArrayBuffer[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const encrypted = await fetchChunk(i);
    const decrypted = await decryptChunk(encrypted, fek);
    chunks.push(decrypted);
  }

  // Create blob and trigger download
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
