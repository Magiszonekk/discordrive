// DiscorDrive v4 — Upload pipeline for secure files v2

import { chunkFileStream } from "@ddv4/processing";
import type { FileChunkManifestPlaintext } from "@ddv4/types";
import { UploadStatus } from "@ddv4/types";
import type { UploadedBlobTransportInput } from "@ddv4/types/api";
import { gqlRequest } from "./graphql.js";
import { uploadBlobToApi, BlobUploadError } from "./api.js";
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

const CHUNK_MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const CHUNK_RETRY_BASE_MS = 800;

// Whole-pipeline restarts, on top of the per-chunk retries above. These cover
// failures the per-chunk budget cannot absorb — a network switch (wifi → LTE)
// or an API restart mid-transfer — by re-running the chunk phase against the
// chunks the server confirms it is still missing.
const RESUME_MAX_ATTEMPTS = 3;
const RESUME_BASE_DELAY_MS = 2000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Upload aborted", "AbortError"));
    }, { once: true });
  });
}

/** Definitive failures — retrying cannot help (bad request, expired session). */
function isDefinitiveFailure(err: unknown): boolean {
  return err instanceof BlobUploadError && err.status >= 400 && err.status < 500;
}

async function withChunkRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
      if (isDefinitiveFailure(err)) throw err;
      if (attempt === CHUNK_MAX_ATTEMPTS - 1) throw err;
      const delay = CHUNK_RETRY_BASE_MS * Math.pow(2, attempt); // 800ms, 1.6s, 3.2s
      await abortableDelay(delay, signal);
    }
  }
  throw new Error("Unreachable");
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

// Which chunks of an in-flight upload the server already holds. Authoritative
// where the client is not: a chunk whose response was lost in transit is on
// storage even though this client never saw the ack.
const UPLOAD_STATUS = `
  query UploadStatus($fileId: ID!) {
    uploadStatus(fileId: $fileId) {
      status
      uploadedChunkIndices
      hasManifest
    }
  }
`;

interface UploadStatusResult {
  status: string;
  uploadedChunkIndices: number[];
  hasManifest: boolean;
}

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

    // Chunks safely on storage, keyed by index and carried across resume
    // attempts so a restart re-sends only what is genuinely missing.
    interface DoneChunk {
      manifestEntry: FileChunkManifestPlaintext["chunks"][number];
      /** null once the server already held the chunk — its own row is authoritative. */
      blobRecord: UploadedBlobTransportInput | null;
    }
    const doneChunks = new Map<number, DoneChunk>();
    let serverHasChunks = new Set<number>();

    let uploadedBytes = 0;
    let uploadedBlobs = 0;

    const CONCURRENCY = config.defaultUploadConcurrency;
    uploadStartMs = performance.now();

    const uploadChunk = async (chunk: { index: number; data: Uint8Array }) => {
      if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
      if (doneChunks.has(chunk.index)) return;

      const chunkStartMs = performance.now();
      const chunkBuffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
      const encryptStartMs = performance.now();
      const ciphertext = await encryptFileContentChunk(prepared.rootFek, chunkBuffer);
      const encryptMs = performance.now() - encryptStartMs;
      const blobId = `${realFileId}:chunk:${chunk.index}`;

      // Already on storage from an earlier attempt: the ciphertext is still
      // needed to size its manifest entry, but re-sending the bytes is not.
      // commitManifest needs no record from us either — the row the upload
      // handler wrote stays authoritative under its skipDuplicates insert.
      const alreadyStored = serverHasChunks.has(chunk.index);
      let requestMs = 0;
      let blobRecord: UploadedBlobTransportInput | null = null;

      if (!alreadyStored) {
        const ciphertextBuffer = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
        const requestStartMs = performance.now();
        const uploadResult = await withChunkRetry(
          () => uploadBlobToApi(blobId, ciphertextBuffer, {
            authToken,
            extraHeaders: {
              "X-Upload-Id": uploadId,
              "X-Chunk-Index": String(chunk.index),
              "X-Chunk-Count": String(chunkCount),
              "X-Client-Timestamp": new Date().toISOString(),
            },
          }),
          controller.signal,
        );
        requestMs = performance.now() - requestStartMs;
        blobRecord = {
          blobId: uploadResult.blobId,
          ciphertextSizeBytes: uploadResult.ciphertextSizeBytes,
          ciphertextHash: uploadResult.ciphertextHash,
          storageKind: uploadResult.storageKind,
          storagePath: uploadResult.storagePath,
          discordMessageId: uploadResult.discordMessageId,
          discordChannelId: uploadResult.discordChannelId,
          webhookId: uploadResult.webhookId,
        };
      }

      doneChunks.set(chunk.index, {
        manifestEntry: { index: chunk.index, blobId, ciphertextSizeBytes: ciphertext.byteLength },
        blobRecord,
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
        skippedAlreadyStored: alreadyStored,
        totalChunkMs: Number((performance.now() - chunkStartMs).toFixed(2)),
      });
    };

    // One pass over the file. Workers share the streaming iterator through a
    // mutex; a resume starts a fresh pass, and chunks already in doneChunks
    // fall straight through.
    const runChunkPass = async () => {
      const chunkIter = chunkFileStream(file, LEGACY_UPLOAD_CHUNK_SIZE_BYTES)[Symbol.asyncIterator]();
      let iterLocked = false;
      const iterWaiters: Array<() => void> = [];
      const nextChunk = async (): Promise<{ index: number; data: Uint8Array } | null> => {
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
      };

      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
          const chunk = await nextChunk();
          if (!chunk) break;
          await uploadChunk(chunk);
        }
      };

      // allSettled, not all: a rejection from one worker leaves the others
      // running, and a resume must not start a second pass over the same file
      // while stragglers from the failed one are still uploading. Waiting for
      // every worker to settle also lets the survivors land more chunks first.
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(CONCURRENCY, chunkCount) }, () => worker()),
      );
      const failure = results.find((r) => r.status === "rejected");
      if (failure) throw (failure as PromiseRejectedResult).reason;
    };

    for (let attempt = 1; ; attempt++) {
      try {
        await runChunkPass();
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (isDefinitiveFailure(error)) throw error;
        if (attempt >= RESUME_MAX_ATTEMPTS) throw error;

        // Reconcile with the server before retrying: chunks whose ack was lost
        // in transit are on storage already and must not be sent twice.
        try {
          const { uploadStatus } = await gqlRequest<{ uploadStatus: UploadStatusResult }>(
            UPLOAD_STATUS, { fileId: realFileId }, authToken,
          );
          serverHasChunks = new Set(uploadStatus.uploadedChunkIndices);
        } catch {
          // Best effort — without it we simply resume from local state.
        }

        logUploadEvent({
          type: "upload_resume_attempt",
          uploadId,
          fileId: realFileId,
          attempt,
          chunksConfirmedLocally: doneChunks.size,
          chunksOnServer: serverHasChunks.size,
          error: error instanceof Error ? error.message : String(error),
        });

        await abortableDelay(RESUME_BASE_DELAY_MS * Math.pow(2, attempt - 1), controller.signal);
      }
    }

    const doneInOrder = Array.from(doneChunks.values()).sort(
      (a, b) => a.manifestEntry.index - b.manifestEntry.index,
    );
    manifest.chunks = doneInOrder.map((c) => c.manifestEntry);
    const uploadedBlobRecords: UploadedBlobTransportInput[] = doneInOrder
      .map((c) => c.blobRecord)
      .filter((record): record is UploadedBlobTransportInput => record !== null);

    store.updateUpload(realFileId, { status: UploadStatus.COMMITTING_MANIFEST });

    const manifestEncryptStartMs = performance.now();
    const encryptedManifest = await buildEncryptedManifest(prepared.rootFek, manifest);
    const manifestEncryptMs = performance.now() - manifestEncryptStartMs;
    const manifestBlobId = `${realFileId}:manifest`;
    const manifestBuffer = encryptedManifest.buffer.slice(encryptedManifest.byteOffset, encryptedManifest.byteOffset + encryptedManifest.byteLength) as ArrayBuffer;
    const manifestRequestStartMs = performance.now();
    // Retried like any chunk: every byte is already up by this point, so losing
    // the manifest to a transient blip would waste the whole transfer.
    const manifestUploadResult = await withChunkRetry(
      () => uploadBlobToApi(manifestBlobId, manifestBuffer, {
        authToken,
        extraHeaders: {
          "X-Upload-Id": uploadId,
          "X-Chunk-Index": "manifest",
          "X-Chunk-Count": String(chunkCount),
          "X-Client-Timestamp": new Date().toISOString(),
        },
      }),
      controller.signal,
    );
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
    // The one call that turns an UPLOADING row into a READY file, so a blip here
    // would waste the whole transfer. Retried — and if the retries still fail the
    // server is asked directly, because a commit whose response was lost in
    // transit did land: the file is READY even though this client saw an error.
    let commitSucceeded: boolean;
    try {
      const { commitManifest } = await withChunkRetry(
        () => gqlRequest<{ commitManifest: { success: boolean } }>(COMMIT_MANIFEST, {
          fileId: realFileId,
          manifestBlobId,
          totalCiphertextBytes: String(file.size),
          chunkCount: chunkCount,
          blobs: uploadedBlobRecords,
        }, authToken),
        controller.signal,
      );
      commitSucceeded = commitManifest.success;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const { uploadStatus } = await gqlRequest<{ uploadStatus: UploadStatusResult }>(
        UPLOAD_STATUS, { fileId: realFileId }, authToken,
      );
      if (uploadStatus.status !== "READY") throw error;
      commitSucceeded = true;
      logUploadEvent({
        type: "upload_commit_recovered",
        uploadId,
        fileId: realFileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

    if (!commitSucceeded) {
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
    // Abort any stray concurrent workers so they don't silently keep uploading
    // after the upload is already considered failed.
    if (!controller.signal.aborted) controller.abort();
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
