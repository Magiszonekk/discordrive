// DiscorDrive v4 — Upload pipeline for secure files v2

import { chunkFileStream } from "@ddv4/processing";
import type { FileChunkManifestPlaintext } from "@ddv4/types";
import { UploadStatus } from "@ddv4/types";
import type { UploadedBlobTransportInput } from "@ddv4/types/api";
import { gqlRequest } from "./graphql.js";
import { uploadBlobToApi } from "./api.js";
import { prepareFileUpload, buildEncryptedManifest, encryptFileContentChunk } from "./crypto.js";
import { LEGACY_UPLOAD_CHUNK_SIZE_BYTES } from "./upload-constants.js";
import { config } from "@ddv4/config";
import { useUploadStore } from "../stores/upload.js";
import { useAuthStore } from "../stores/auth.js";

interface UploadTelemetryEvent {
  type: string;
  [key: string]: unknown;
}

function isUploadDebugEnabled(): boolean {
  try {
    return localStorage.getItem("uploadDebug") === "1";
  } catch {
    return false;
  }
}

function logUploadEvent(event: UploadTelemetryEvent): void {
  if (!isUploadDebugEnabled()) return;
  console.debug("[upload-debug]", {
    ts: new Date().toISOString(),
    ...event,
  });
}

const INIT_UPLOAD = `
  mutation InitUpload(
    $parentFolderId: ID
    $encryptedName: String
    $encryptedMimeType: String
    $wrappedFEK: String!
    $totalCiphertextBytes: String!
    $chunkCount: Int!
  ) {
    initUpload(
      parentFolderId: $parentFolderId
      encryptedName: $encryptedName
      encryptedMimeType: $encryptedMimeType
      wrappedFEK: $wrappedFEK
      totalCiphertextBytes: $totalCiphertextBytes
      chunkCount: $chunkCount
    ) { fileId status }
  }
`;


const COMMIT_MANIFEST = `
  mutation CommitManifest(
    $fileId: ID!
    $manifestBlobId: String!
    $totalCiphertextBytes: String!
    $chunkCount: Int!
    $blobs: [UploadedBlobTransportInput!]!
  ) {
    commitManifest(
      fileId: $fileId
      manifestBlobId: $manifestBlobId
      totalCiphertextBytes: $totalCiphertextBytes
      chunkCount: $chunkCount
      blobs: $blobs
    ) { success }
  }
`;

export async function uploadFile(file: File, folderId: string | null): Promise<string> {
  const authState = useAuthStore.getState();
  const filesKey = authState.filesKey;
  const authToken = authState.token;

  if (!authToken) {
    throw new Error("Session expired or missing API auth token. Log in again.");
  }

  if (!filesKey) {
    throw new Error("Session is locked. Unlock it before uploading.");
  }

  const store = useUploadStore.getState();
  const uploadId = crypto.randomUUID();
  const placeholderId = `pending:${uploadId}`;
  const sessionStartMs = performance.now();

  // Chunk count computed from file size — no need to buffer the whole file first.
  const chunkCount = Math.ceil(file.size / LEGACY_UPLOAD_CHUNK_SIZE_BYTES);
  const totalBlobs = chunkCount + 1;

  logUploadEvent({
    type: "upload_session_started",
    uploadId,
    fileName: file.name,
    fileSize: file.size,
    folderId,
    chunkSize: LEGACY_UPLOAD_CHUNK_SIZE_BYTES,
    chunkCount,
    concurrency: config.defaultUploadConcurrency,
    mode: "streaming",
    tokenPresentAtStart: Boolean(authToken),
  });
  const controller = new AbortController();

  store.addUpload(placeholderId, totalBlobs, file.size, file.name);
  store.registerController(placeholderId, controller);
  store.updateUpload(placeholderId, { status: UploadStatus.ENCRYPTING });

  let activeUploadId = placeholderId;
  let uploadStartMs: number | null = null;

  try {
    const prepareStartMs = performance.now();
    const prepared = await prepareFileUpload(filesKey, {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      plaintextSizeBytes: file.size,
    });
    const prepareMs = performance.now() - prepareStartMs;

    const initUploadStartMs = performance.now();
    const { initUpload } = await gqlRequest<{ initUpload: { fileId: string; status: string } }>(INIT_UPLOAD, {
      parentFolderId: folderId,
      encryptedName: prepared.encryptedName,
      encryptedMimeType: prepared.encryptedMimeType,
      wrappedFEK: prepared.wrappedFEK,
      totalCiphertextBytes: String(file.size),
      chunkCount,
    }, authToken);
    const initUploadMs = performance.now() - initUploadStartMs;

    logUploadEvent({
      type: "upload_prepare_and_init_timing",
      uploadId,
      fileName: file.name,
      fileSize: file.size,
      chunkCount: chunkCount,
      prepareMs: Number(prepareMs.toFixed(2)),
      initUploadMs: Number(initUploadMs.toFixed(2)),
      preUploadWallMs: Number((performance.now() - sessionStartMs).toFixed(2)),
    });

    const realFileId = initUpload.fileId;
    store.removeUpload(placeholderId);
    activeUploadId = realFileId;
    store.addUpload(realFileId, totalBlobs, file.size, file.name);
    store.registerController(realFileId, controller);
    store.updateUpload(realFileId, { status: UploadStatus.UPLOADING });

    const manifest: FileChunkManifestPlaintext = {
      schemaVersion: 1,
      chunkSizeBytes: LEGACY_UPLOAD_CHUNK_SIZE_BYTES,
      chunks: [],
    };

    const uploadedBlobRecords: UploadedBlobTransportInput[] = [];
    let uploadedBytes = 0;
    let uploadedBlobs = 0;

    const CONCURRENCY = config.defaultUploadConcurrency;
    uploadStartMs = performance.now();

    // Streaming chunk iterator with mutex — safe to share across concurrent workers.
    const chunkIter = chunkFileStream(file, LEGACY_UPLOAD_CHUNK_SIZE_BYTES)[Symbol.asyncIterator]();
    let iterLocked = false;
    const iterWaiters: Array<() => void> = [];
    async function nextChunk(): Promise<{ index: number; data: Uint8Array } | null> {
      while (iterLocked) {
        await new Promise<void>(resolve => iterWaiters.push(resolve));
      }
      iterLocked = true;
      try {
        const result = await chunkIter.next();
        return result.done ? null : result.value;
      } finally {
        iterLocked = false;
        iterWaiters.shift()?.();
      }
    }

    const uploadChunk = async (chunk: { index: number; data: Uint8Array }) => {
      if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");

      const chunkStartMs = performance.now();
      const chunkBuffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
      const encryptStartMs = performance.now();
      const ciphertext = await encryptFileContentChunk(prepared.rootFek, chunkBuffer);
      const encryptMs = performance.now() - encryptStartMs;
      const blobId = `${realFileId}:chunk:${chunk.index}`;
      const ciphertextBuffer = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
      const requestStartMs = performance.now();
      const uploadResult = await uploadBlobToApi(blobId, ciphertextBuffer, {
        authToken,
        extraHeaders: {
          "X-Upload-Id": uploadId,
          "X-Chunk-Index": String(chunk.index),
          "X-Chunk-Count": String(chunkCount),
          "X-Client-Timestamp": new Date().toISOString(),
        },
      });
      const requestMs = performance.now() - requestStartMs;

      manifest.chunks.push({
        index: chunk.index,
        blobId,
        ciphertextSizeBytes: ciphertext.byteLength,
      });

      uploadedBlobRecords.push({
        blobId: uploadResult.blobId,
        ciphertextSizeBytes: uploadResult.ciphertextSizeBytes,
        ciphertextHash: uploadResult.ciphertextHash,
        storageKind: uploadResult.storageKind,
        storagePath: uploadResult.storagePath,
        discordMessageId: uploadResult.discordMessageId,
        discordChannelId: uploadResult.discordChannelId,
        webhookId: uploadResult.webhookId,
      });

      uploadedBytes += chunk.data.byteLength;
      uploadedBlobs += 1;
      store.updateUpload(realFileId, { uploadedBlobs, bytesUploaded: uploadedBytes });

      logUploadEvent({
        type: "upload_chunk_timing",
        uploadId,
        fileId: realFileId,
        chunkIndex: chunk.index,
        chunkCount: chunkCount,
        plaintextBytes: chunk.data.byteLength,
        ciphertextBytes: ciphertext.byteLength,
        encryptMs: Number(encryptMs.toFixed(2)),
        requestMs: Number(requestMs.toFixed(2)),
        totalChunkMs: Number((performance.now() - chunkStartMs).toFixed(2)),
      });
    };

    const worker = async () => {
      while (true) {
        if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
        const chunk = await nextChunk();
        if (!chunk) break;
        await uploadChunk(chunk);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, chunkCount) }, () => worker()),
    );

    manifest.chunks.sort((a, b) => a.index - b.index);
    store.updateUpload(realFileId, { status: UploadStatus.COMMITTING_MANIFEST });

    const manifestEncryptStartMs = performance.now();
    const encryptedManifest = await buildEncryptedManifest(prepared.rootFek, manifest);
    const manifestEncryptMs = performance.now() - manifestEncryptStartMs;
    const manifestBlobId = `${realFileId}:manifest`;
    const manifestBuffer = encryptedManifest.buffer.slice(encryptedManifest.byteOffset, encryptedManifest.byteOffset + encryptedManifest.byteLength) as ArrayBuffer;
    const manifestRequestStartMs = performance.now();
    const manifestUploadResult = await uploadBlobToApi(manifestBlobId, manifestBuffer, {
      authToken,
      extraHeaders: {
        "X-Upload-Id": uploadId,
        "X-Chunk-Index": "manifest",
        "X-Chunk-Count": String(chunkCount),
        "X-Client-Timestamp": new Date().toISOString(),
      },
    });
    const manifestRequestMs = performance.now() - manifestRequestStartMs;

    uploadedBlobRecords.push({
      blobId: manifestUploadResult.blobId,
      ciphertextSizeBytes: manifestUploadResult.ciphertextSizeBytes,
      ciphertextHash: manifestUploadResult.ciphertextHash,
      storageKind: manifestUploadResult.storageKind,
      storagePath: manifestUploadResult.storagePath,
      discordMessageId: manifestUploadResult.discordMessageId,
      discordChannelId: manifestUploadResult.discordChannelId,
      webhookId: manifestUploadResult.webhookId,
    });

    logUploadEvent({
      type: "upload_manifest_timing",
      uploadId,
      fileId: realFileId,
      manifestBlobId,
      chunkCount: chunkCount,
      encryptMs: Number(manifestEncryptMs.toFixed(2)),
      requestMs: Number(manifestRequestMs.toFixed(2)),
      ciphertextBytes: encryptedManifest.byteLength,
    });

    store.updateUpload(realFileId, { uploadedBlobs: uploadedBlobs + 1, bytesUploaded: file.size });

    const commitManifestStartMs = performance.now();
    const { commitManifest } = await gqlRequest<{ commitManifest: { success: boolean } }>(COMMIT_MANIFEST, {
      fileId: realFileId,
      manifestBlobId,
      totalCiphertextBytes: String(file.size),
      chunkCount: chunkCount,
      blobs: uploadedBlobRecords,
    }, authToken);
    const commitManifestMs = performance.now() - commitManifestStartMs;

    logUploadEvent({
      type: "upload_commit_manifest_timing",
      uploadId,
      fileId: realFileId,
      manifestBlobId,
      chunkCount: chunkCount,
      blobRecordCount: uploadedBlobRecords.length,
      commitManifestMs: Number(commitManifestMs.toFixed(2)),
      elapsedUploadWallMs: Number((performance.now() - uploadStartMs).toFixed(2)),
    });

    if (!commitManifest.success) {
      store.updateUpload(realFileId, { status: UploadStatus.FAILED });
      logUploadEvent({
        type: "upload_session_failed",
        uploadId,
        fileId: realFileId,
        stage: "commit_manifest",
        elapsedMs: Number((performance.now() - uploadStartMs).toFixed(2)),
        error: "Manifest commit failed",
      });
      throw new Error("Manifest commit failed");
    }

    const totalDurationMs = performance.now() - uploadStartMs;
    const totalWallMs = performance.now() - sessionStartMs;
    logUploadEvent({
      type: "upload_session_finished",
      uploadId,
      fileId: realFileId,
      totalDurationMs: Number(totalDurationMs.toFixed(2)),
      totalWallMs: Number(totalWallMs.toFixed(2)),
      totalBytes: file.size,
      avgSpeedBps: totalDurationMs > 0 ? Math.round(file.size / (totalDurationMs / 1000)) : undefined,
      endToEndSpeedBps: totalWallMs > 0 ? Math.round(file.size / (totalWallMs / 1000)) : undefined,
      chunkCount: chunkCount,
      totalBlobs,
      success: true,
    });

    logUploadEvent({
      type: "upload_session_summary",
      uploadId,
      fileId: realFileId,
      fileName: file.name,
      totalBytes: file.size,
      chunkCount: chunkCount,
      totalBlobs,
      uploadPipelineMs: Number(totalDurationMs.toFixed(2)),
      totalWallMs: Number(totalWallMs.toFixed(2)),
      uploadPipelineSpeedBps: totalDurationMs > 0 ? Math.round(file.size / (totalDurationMs / 1000)) : undefined,
      endToEndSpeedBps: totalWallMs > 0 ? Math.round(file.size / (totalWallMs / 1000)) : undefined,
    });

    store.updateUpload(realFileId, { status: UploadStatus.DONE });

    return realFileId;
  } catch (error) {
    logUploadEvent({
      type: "upload_session_failed",
      uploadId,
      fileId: activeUploadId,
      stage: "upload_pipeline",
      elapsedMs: uploadStartMs !== null ? Number((performance.now() - uploadStartMs).toFixed(2)) : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    store.updateUpload(activeUploadId, { status: UploadStatus.FAILED });
    throw error;
  }
}
