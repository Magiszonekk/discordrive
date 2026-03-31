// DiscorDrive v4 — Upload pipeline
// Hashing and GraphQL orchestration in main thread.
// Chunk encryption + upload delegated to Service Worker via @discordrive/stream-engine.

import { hashFile, calculateChunkCount } from "@discordrive/processing";
import { config } from "@discordrive/config";
import { gqlRequest } from "./graphql.js";
import { prepareFileUpload } from "./crypto.js";
import { uploadViaSW } from "./swUpload.js";
import { useUploadStore } from "../stores/upload.js";
import { useAuthStore } from "../stores/auth.js";
import { UploadStatus } from "@discordrive/types";

const INIT_UPLOAD = `
  mutation InitUpload(
    $name: String!, $mimeType: String!, $size: String!,
    $chunkSize: Int!, $chunkCount: Int!,
    $encryptedFEK: String!, $fekIv: String!, $folderId: ID
  ) {
    initUpload(
      name: $name, mimeType: $mimeType, size: $size,
      chunkSize: $chunkSize, chunkCount: $chunkCount,
      encryptedFEK: $encryptedFEK, fekIv: $fekIv, folderId: $folderId
    ) { fileId }
  }
`;

const FINALIZE_UPLOAD = `
  mutation FinalizeUpload($fileId: ID!, $sha256: String!) {
    finalizeUpload(fileId: $fileId, sha256: $sha256) {
      success
      missingChunks
    }
  }
`;

const DELETE_FILE = `
  mutation DeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId)
  }
`;

export async function uploadFile(
  file: File,
  folderId: string | null,
): Promise<string> {
  const masterKey = useAuthStore.getState().masterKey;
  if (!masterKey) throw new Error("Not authenticated");

  const store = useUploadStore.getState();
  const chunkSize = config.defaultChunkSize;
  const chunkCount = calculateChunkCount(file.size, chunkSize);

  // 1. Prepare FEK
  const { fek, encryptedFEK, fekIv } = await prepareFileUpload(masterKey);

  // Create AbortController for this upload and register it in the store
  const controller = new AbortController();

  // 2. Hash file
  store.addUpload("pending", file.name, chunkCount, file.size);
  store.registerController("pending", controller);
  store.updateUpload("pending", { status: UploadStatus.HASHING });

  const sha256 = await hashFile(file);

  // Check if cancelled during hashing (before any DB record exists)
  if (controller.signal.aborted) {
    store.removeUpload("pending");
    return "";
  }

  // 3. Init upload
  store.updateUpload("pending", { status: UploadStatus.UPLOADING });

  const { initUpload } = await gqlRequest<{
    initUpload: { fileId: string };
  }>(INIT_UPLOAD, {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size.toString(),
    chunkSize,
    chunkCount,
    encryptedFEK,
    fekIv,
    folderId,
  });

  const fileId = initUpload.fileId;

  // Update store with real fileId, re-register controller under it
  store.removeUpload("pending");
  store.addUpload(fileId, file.name, chunkCount, file.size);
  store.registerController(fileId, controller);
  store.updateUpload(fileId, { status: UploadStatus.UPLOADING });

  // 4. Upload chunks via Service Worker (encrypt + upload with concurrency)
  try {
    await uploadViaSW(file, fileId, fek, chunkSize, (progress) => {
      store.updateUpload(fileId, {
        uploadedChunks: progress.uploadedChunks,
        bytesUploaded: progress.bytesUploaded,
      });
    }, controller.signal);
  } catch (err) {
    if ((err as DOMException).name === "AbortError") {
      store.removeUpload(fileId);
      gqlRequest(DELETE_FILE, { fileId }).catch(() => {});
      return "";
    }
    store.updateUpload(fileId, { status: UploadStatus.FAILED });
    throw err;
  }

  // 5. Finalize
  store.updateUpload(fileId, { status: UploadStatus.FINALIZING });

  const { finalizeUpload } = await gqlRequest<{
    finalizeUpload: { success: boolean; missingChunks?: number[] };
  }>(FINALIZE_UPLOAD, { fileId, sha256 });

  if (!finalizeUpload.success) {
    store.updateUpload(fileId, { status: UploadStatus.FAILED });
    throw new Error(
      `Upload incomplete. Missing chunks: ${finalizeUpload.missingChunks?.join(", ")}`,
    );
  }

  store.updateUpload(fileId, { status: UploadStatus.DONE });
  return fileId;
}
