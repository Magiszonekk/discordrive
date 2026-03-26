// DiscorDrive v4 — Upload pipeline

import { encryptChunk, calculateChunkCount } from "@ddv4/processing";
import { config } from "@ddv4/config";
import { gqlRequest } from "./graphql.js";
import { uploadChunkToApi } from "./api.js";
import { prepareFileUpload } from "./crypto.js";
import { useUploadStore } from "../stores/upload.js";
import { useAuthStore } from "../stores/auth.js";
import { UploadStatus } from "@ddv4/types";
import { EncryptionPool } from "./encryption-pool.js";

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
    ) { fileId uploadConcurrency }
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

const debugUpload = () => localStorage.getItem("DDVR_DEBUG") === "1";

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

  // 2. Start background hash worker — reads file independently, concurrently with upload
  const hashWorker = new Worker(
    new URL("./hash.worker.ts", import.meta.url),
    { type: "module" },
  );
  const hashPromise = new Promise<string>((resolve, reject) => {
    hashWorker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "done") resolve(e.data.sha256 as string);
      else reject(new Error(e.data.message as string));
    };
    hashWorker.onerror = (e) => reject(new Error(e.message));
  });
  hashWorker.postMessage({ type: "hash", file });

  // 3. Init upload
  store.addUpload("pending", file.name, chunkCount, file.size);
  store.updateUpload("pending", { status: UploadStatus.UPLOADING });

  const { initUpload } = await gqlRequest<{
    initUpload: { fileId: string; uploadConcurrency: number };
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

  // Update store with real fileId
  store.removeUpload("pending");
  store.addUpload(fileId, file.name, chunkCount, file.size);
  store.updateUpload(fileId, { status: UploadStatus.UPLOADING });

  // 4. Upload chunks with concurrency control + fail-fast
  const concurrency = initUpload.uploadConcurrency || config.defaultUploadConcurrency;
  let uploadedChunks = 0;
  let bytesUploaded = 0;
  const failedChunks: number[] = [];
  const abortController = new AbortController();
  store.registerAbortController(fileId, abortController);
  const uploadStartTime = Date.now();

  const debug = debugUpload();

  // Create encryption worker pool (falls back to main-thread if Workers unavailable)
  const fekRaw = await crypto.subtle.exportKey("raw", fek);
  const pool = await EncryptionPool.create(fekRaw);

  // Producer-consumer pipeline: decouple file reading from dispatch.
  // Two tiers: fast (≤1GB) uses full concurrency, safe (>1GB) caps pipeline to limit RAM.
  // At pipeline=40 + prefetch=44, peak RAM is ~1.4GB + GC lag → OOM for large files.
  const isLargeFile = file.size > 1024 * 1024 * 1024; // >1 GB
  const inFlight = new Set<Promise<void>>();
  const pipelineDepth = isLargeFile ? Math.min(concurrency, 10) : concurrency;
  const PREFETCH = isLargeFile ? 4 : pipelineDepth + 4;

  if (debug) {
    console.log(`[UPLOAD] encryption: ${pool ? "worker pool" : "main thread"}, pipeline: ${pipelineDepth}, prefetch: ${PREFETCH}, tier: ${isLargeFile ? "safe" : "fast"}`);
  }

  // --- Producer: reads file chunks into a bounded buffer (no hashing — done in background worker) ---
  type BufferedChunk = { index: number; chunkBuf: ArrayBuffer; size: number };
  const chunkBuffer: BufferedChunk[] = [];
  let producerDone = false;
  const signal = {
    onChunkReady: null as (() => void) | null,
    onSpaceReady: null as (() => void) | null,
  };

  // Parallel read-ahead: start N reads concurrently, process in order
  const PARALLEL_READS = isLargeFile ? 2 : 4;

  const readSlice = (idx: number): Promise<Uint8Array> => {
    const s = idx * chunkSize;
    const e = Math.min(s + chunkSize, file.size);
    return file.slice(s, e).arrayBuffer().then((b) => new Uint8Array(b));
  };

  const producer = (async () => {
    // Start initial parallel reads
    const pending: (Promise<Uint8Array> | undefined)[] = [];
    for (let i = 0; i < Math.min(PARALLEL_READS, chunkCount); i++) {
      pending[i] = readSlice(i);
    }
    let nextToRead = Math.min(PARALLEL_READS, chunkCount);

    for (let index = 0; index < chunkCount; index++) {
      if (abortController.signal.aborted) break;

      // Await this chunk (read already started in parallel)
      const readStart = debug ? performance.now() : 0;
      const data = await pending[index]!;
      pending[index] = undefined; // free reference

      // Start next read-ahead
      if (nextToRead < chunkCount && !abortController.signal.aborted) {
        pending[nextToRead] = readSlice(nextToRead);
        nextToRead++;
      }

      if (debug) {
        const readMs = performance.now() - readStart;
        console.log(
          `[UPLOAD] producer ${index}/${chunkCount}: read=${readMs.toFixed(0)}ms buf=${chunkBuffer.length}`,
        );
      }

      // Wait if buffer is full (backpressure from consumer)
      while (chunkBuffer.length >= PREFETCH && !abortController.signal.aborted) {
        await new Promise<void>((r) => { signal.onSpaceReady = () => r(); });
      }
      if (abortController.signal.aborted) break;

      // Use data.buffer directly — no copy needed (file.slice returns a fresh buffer)
      chunkBuffer.push({ index, chunkBuf: data.buffer as ArrayBuffer, size: data.byteLength });
      signal.onChunkReady?.();
      signal.onChunkReady = null;
    }
    producerDone = true;
    signal.onChunkReady?.(); // wake consumer if waiting
  })();

  // --- Consumer: dispatches encrypt+upload from the buffer ---
  while (true) {
    // Wait for a chunk to be available
    while (chunkBuffer.length === 0 && !producerDone) {
      await new Promise<void>((r) => { signal.onChunkReady = () => r(); });
    }
    if (chunkBuffer.length === 0 && producerDone) break;
    if (abortController.signal.aborted) break;

    // Backpressure: wait if pipeline is full
    while (inFlight.size >= pipelineDepth) {
      await Promise.race(inFlight);
    }
    if (abortController.signal.aborted) break;

    const { index, chunkBuf, size } = chunkBuffer.shift()!;
    signal.onSpaceReady?.();
    signal.onSpaceReady = null; // wake producer if waiting for space

    const dispatchTime = performance.now();

    // Fire off encrypt + upload as a single concurrent operation.
    // Error handling is INLINE to avoid orphaned .catch()/.finally() promise chains
    // that keep the async closure (and its 10MB encrypted buffer) alive until V8 GC
    // collects the orphaned promises — which caused 10GB+ RAM for large files.
    const work = (async () => {
      try {
        const encryptStart = performance.now();
        let encrypted = pool
          ? await pool.encrypt(index, chunkBuf)
          : await encryptChunk(chunkBuf, fek);
        const encryptMs = performance.now() - encryptStart;

        if (abortController.signal.aborted) return;

        const uploadStart = performance.now();
        await uploadChunkToApi(fileId, index, encrypted, abortController.signal);
        const uploadMs = performance.now() - uploadStart;

        // Release 10MB encrypted buffer immediately — don't wait for GC
        encrypted = undefined!;

        uploadedChunks++;
        bytesUploaded += size;
        const elapsedMs = Date.now() - uploadStartTime;
        const speedBps = elapsedMs > 0 ? Math.round((bytesUploaded / elapsedMs) * 1000) : 0;
        store.updateUpload(fileId, {
          uploadedChunks,
          bytesUploaded,
          speedBps,
        });

        if (debug) {
          const totalMs = performance.now() - dispatchTime;
          console.log(
            `[UPLOAD] chunk ${index}/${chunkCount}: encrypt=${encryptMs.toFixed(0)}ms upload=${uploadMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms inflight=${inFlight.size}`,
          );
        }
      } catch (err) {
        // Fail-fast: any chunk error aborts the whole upload
        if (!abortController.signal.aborted) {
          console.error(`Chunk ${index} failed:`, err);
          failedChunks.push(index);
          abortController.abort();
        }
      }
    })();

    inFlight.add(work);
    const remove = () => { inFlight.delete(work); };
    work.then(remove, remove);
  }

  // Wait for producer and all in-flight operations to settle
  await producer;
  await Promise.allSettled(inFlight);

  // Clean up encryption workers
  pool?.destroy();

  if (abortController.signal.aborted && failedChunks.length === 0) {
    // Cancelled by user — store already has CANCELLED status set by cancelUpload()
    hashWorker.terminate();
    throw new Error("Upload cancelled");
  }

  if (failedChunks.length > 0) {
    hashWorker.terminate();
    store.updateUpload(fileId, { status: UploadStatus.FAILED });
    throw new Error(
      `Upload failed. ${failedChunks.length} chunk(s) failed: ${failedChunks.join(", ")}`,
    );
  }

  if (debug) {
    const totalSec = (Date.now() - uploadStartTime) / 1000;
    const mbps = (bytesUploaded / (1024 * 1024)) / totalSec;
    console.log(
      `[UPLOAD] done: ${uploadedChunks} chunks in ${totalSec.toFixed(1)}s, ${mbps.toFixed(1)} MB/s`,
    );
  }

  // 5. Finalize — await background hash (may still be running for large files)
  store.updateUpload(fileId, { status: UploadStatus.FINALIZING });
  const sha256 = await hashPromise;
  hashWorker.terminate();

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
