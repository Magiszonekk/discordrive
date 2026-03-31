#!/usr/bin/env npx tsx
// DiscorDrive v4 — E2E Pipeline Benchmark
// Tests the full pipeline: generate → encrypt → API upload → API download → decrypt → verify.
// Measures end-to-end throughput including API server, DB, Discord, and crypto overhead.
//
// Usage: npx tsx scripts/benchmark-e2e.ts [fileSize] [concurrency] [--stream]
// Default file size: 25 MB
// Default concurrency: 3
// --stream: streaming mode — generate+encrypt+upload in one pipeline (lower RAM)
//
// Requires:
//   - Running API server: npm run dev:api
//   - APP_MODE=backend-only in .env (optional API_KEY)
//   - PostgreSQL + WEBHOOK_* configured

import "dotenv/config";
import { randomBytes, createHash } from "node:crypto";
import { config } from "@discordrive/config";
import {
  generateFEK,
  generateMasterKey,
  wrapKey,
  encryptChunk,
  decryptChunk,
  toBase64,
  hashBuffer,
} from "@discordrive/processing";
import { UploadEngine, type ChunkSource, type ChunkSink } from "@discordrive/stream-engine";
import {
  formatBytes,
  formatDuration,
  throughput,
  parseSize,
  startTicker,
  printSummary,
  printChunkStats,
  type TimingResult,
} from "./bench-utils.js";

// === Config ===

const apiPort = process.env.API_PORT ?? "3000";
const baseUrl = `http://localhost:${apiPort}`;
const apiKey = process.env.API_KEY ?? "";

// === GraphQL helper ===

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
  return json.data!;
}

// === Node.js adapters for stream-engine ===

class NodeChunkSource implements ChunkSource {
  async fetch(fileId: string, chunkIndex: number): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(`${baseUrl}/api/download/${fileId}/chunk/${chunkIndex}`, { headers });
    if (!res.ok) throw new Error(`Download chunk ${chunkIndex} failed: ${res.status}`);
    return res.arrayBuffer();
  }
}

class NodeChunkSink implements ChunkSink {
  async upload(fileId: string, chunkIndex: number, encrypted: ArrayBuffer): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(`${baseUrl}/api/upload/${fileId}/chunk/${chunkIndex}`, {
      method: "POST",
      headers,
      body: encrypted,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Upload failed" })) as { error: string };
      throw new Error(`Upload chunk ${chunkIndex} failed: ${err.error}`);
    }
  }
}

// === GraphQL Mutations ===

const INIT_UPLOAD = `
  mutation InitUpload(
    $name: String!, $mimeType: String!, $size: String!,
    $chunkSize: Int!, $chunkCount: Int!,
    $encryptedFEK: String!, $fekIv: String!
  ) {
    initUpload(
      name: $name, mimeType: $mimeType, size: $size,
      chunkSize: $chunkSize, chunkCount: $chunkCount,
      encryptedFEK: $encryptedFEK, fekIv: $fekIv
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

// === Main ===

async function main() {
  const totalBytes = parseSize(process.argv[2] ?? "25");
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(totalBytes / chunkSize);
  const concurrency = parseInt(process.argv[3] ?? "3", 10);
  const streamMode = process.argv.includes("--stream");

  // Pre-check: API server alive?
  console.log(`\nChecking API server at ${baseUrl}...`);
  try {
    const res = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("  API server is running.\n");
  } catch (err) {
    console.error(`  ERROR: Cannot reach API server at ${baseUrl}`);
    console.error("  Start it with: npm run dev:api");
    console.error("  Make sure APP_MODE=backend-only is set in .env\n");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  DiscorDrive E2E Pipeline Benchmark");
  console.log("═══════════════════════════════════════════");
  console.log(`  File size:    ${formatBytes(totalBytes)}`);
  console.log(`  Chunk size:   ${formatBytes(chunkSize)}`);
  console.log(`  Chunk count:  ${chunkCount}`);
  console.log(`  Concurrency:  ${concurrency}`);
  console.log(`  Mode:         ${streamMode ? "streaming (gen+enc+upload pipeline)" : "batch (pre-buffered)"}`);
  console.log(`  API:          ${baseUrl}`);
  console.log(`  Auth:         ${apiKey ? "API key" : "open (no API_KEY)"}`);
  console.log("═══════════════════════════════════════════\n");

  const timings: TimingResult[] = [];

  // =========================================================================
  // STREAM MODE: generate + encrypt + upload as one pipeline (low RAM)
  // =========================================================================
  if (streamMode) {
    // Crypto setup
    const fek = await generateFEK();
    const masterKey = await generateMasterKey();
    const wrappedFek = await wrapKey(fek, masterKey);
    const encryptedFEK = toBase64(wrappedFek.data);
    const fekIv = toBase64(wrappedFek.iv);

    // Init upload
    const { initUpload } = await gql<{ initUpload: { fileId: string } }>(INIT_UPLOAD, {
      name: `benchmark_stream_${Date.now()}.bin`,
      mimeType: "application/octet-stream",
      size: totalBytes.toString(),
      chunkSize,
      chunkCount,
      encryptedFEK,
      fekIv,
    });
    const fileId = initUpload.fileId;
    console.log(`Streaming pipeline (generate → encrypt → upload)...`);
    console.log(`  File ID: ${fileId}`);

    // Stream pipeline: generate chunks, hash them, encrypt+upload via engine
    const hasher = createHash("sha256");

    async function* streamingChunks(): AsyncIterable<{ index: number; data: Uint8Array }> {
      for (let i = 0; i < chunkCount; i++) {
        const size = Math.min(chunkSize, totalBytes - i * chunkSize);
        const data = new Uint8Array(randomBytes(size));
        hasher.update(data);
        yield { index: i, data };
      }
    }

    const uploadEngine = new UploadEngine();
    const sink = new NodeChunkSink();
    const pipelineProgress = { count: 0, bytes: 0 };
    const pipelineStart = performance.now();
    const pipelineTicker = startTicker("Pipeline", chunkCount, pipelineProgress, pipelineStart);

    await uploadEngine.uploadStream(
      fileId,
      streamingChunks(),
      chunkCount,
      { fek, chunkSize, concurrency, maxRetries: 5 },
      sink,
      (progress) => {
        pipelineProgress.count = progress.uploadedChunks;
        pipelineProgress.bytes = progress.bytesUploaded;
      },
    );
    clearInterval(pipelineTicker);

    const pipelineMs = performance.now() - pipelineStart;
    const originalHash = hasher.digest("hex");
    timings.push({ label: "Gen + encrypt + upload", durationMs: pipelineMs, bytes: totalBytes });
    process.stdout.write(`\r  Pipeline: ${chunkCount}/${chunkCount} (100%) — ${throughput(totalBytes, pipelineMs)}    \n`);
    console.log(`  Pipeline complete: ${formatDuration(pipelineMs)} (${throughput(totalBytes, pipelineMs)})\n`);

    // Finalize
    const { finalizeUpload } = await gql<{
      finalizeUpload: { success: boolean; missingChunks?: number[] };
    }>(FINALIZE_UPLOAD, { fileId, sha256: originalHash });

    if (!finalizeUpload.success) {
      console.error(`  FAILED: Missing chunks: ${finalizeUpload.missingChunks?.join(", ")}`);
      process.exit(1);
    }
    console.log(`  Finalized.\n`);

    // Download
    console.log(`Downloading through API (concurrency: ${concurrency})...`);
    const source = new NodeChunkSource();
    const chunkDownloadTimes: number[] = new Array(chunkCount);
    const downloadProgress = { count: 0, bytes: 0 };
    const downloadStart = performance.now();
    const downloadTicker = startTicker("Download", chunkCount, downloadProgress, downloadStart);
    const downloadedEncrypted: ArrayBuffer[] = new Array(chunkCount);
    const dlTasks = Array.from({ length: chunkCount }, (_, i) => async () => {
      const t0 = performance.now();
      downloadedEncrypted[i] = await source.fetch(fileId, i);
      chunkDownloadTimes[i] = performance.now() - t0;
      downloadProgress.count++;
      downloadProgress.bytes += downloadedEncrypted[i].byteLength;
    });
    let dlIdx = 0;
    const dlWorker = async () => { while (dlIdx < dlTasks.length) await dlTasks[dlIdx++](); };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunkCount) }, dlWorker));
    clearInterval(downloadTicker);
    const downloadedBytes = downloadedEncrypted.reduce((sum, c) => sum + c.byteLength, 0);
    const downloadMs = performance.now() - downloadStart;
    timings.push({ label: "Download (API)", durationMs: downloadMs, bytes: downloadedBytes });
    process.stdout.write(`\r  Download: ${chunkCount}/${chunkCount} (100%) — ${throughput(downloadedBytes, downloadMs)}    \n`);
    console.log(`  Download complete: ${formatDuration(downloadMs)} (${throughput(downloadedBytes, downloadMs)})\n`);

    // Decrypt + verify
    console.log("Decrypting and verifying integrity...");
    const decStart = performance.now();
    const decryptedChunks: ArrayBuffer[] = [];
    for (let i = 0; i < chunkCount; i++) {
      decryptedChunks.push(await decryptChunk(downloadedEncrypted[i], fek));
    }
    const reassembledSize = decryptedChunks.reduce((sum, c) => sum + c.byteLength, 0);
    const reassembled = new Uint8Array(reassembledSize);
    let rOffset = 0;
    for (const chunk of decryptedChunks) { reassembled.set(new Uint8Array(chunk), rOffset); rOffset += chunk.byteLength; }
    const downloadHash = await hashBuffer(reassembled.buffer.slice(reassembled.byteOffset, reassembled.byteOffset + reassembled.byteLength) as ArrayBuffer);
    const decMs = performance.now() - decStart;
    timings.push({ label: "Decrypt + verify", durationMs: decMs, bytes: reassembledSize });
    const integrityOk = downloadHash === originalHash;
    console.log(`  Decrypt: ${formatDuration(decMs)} (${throughput(reassembledSize, decMs)})`);
    console.log(`  Integrity: ${integrityOk ? "✓ PASS" : "✗ FAIL"}`);
    console.log(`    Original:   ${originalHash.slice(0, 32)}...`);
    console.log(`    Downloaded: ${downloadHash.slice(0, 32)}...`);
    if (!integrityOk) console.error("\n  INTEGRITY CHECK FAILED! Data corruption detected.\n");
    console.log();

    // Cleanup
    console.log("Cleaning up...");
    const deleteStart = performance.now();
    await gql(DELETE_FILE, { fileId });
    const deleteMs = performance.now() - deleteStart;
    timings.push({ label: "Cleanup (delete)", durationMs: deleteMs });
    console.log(`  Done in ${formatDuration(deleteMs)}\n`);

    // Report
    printSummary(timings);
    printChunkStats("download:", chunkDownloadTimes);
    const streamPipelineMs =
      (timings.find((t) => t.label === "Gen + encrypt + upload")?.durationMs ?? 0) +
      (timings.find((t) => t.label === "Download (API)")?.durationMs ?? 0) +
      (timings.find((t) => t.label === "Decrypt + verify")?.durationMs ?? 0);
    console.log(`\n  Pipeline throughput:  ${throughput(totalBytes, streamPipelineMs)} (gen+enc+upload→download→decrypt)`);
    console.log("\n═══════════════════════════════════════════");
    return;
  }

  // =========================================================================
  // BATCH MODE (default): pre-generate all chunks, encrypt, then upload
  // =========================================================================

  // === 1. GENERATE TEST DATA ===
  console.log("Generating random test data...");
  const genStart = performance.now();

  const plainChunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const size = Math.min(chunkSize, totalBytes - i * chunkSize);
    plainChunks.push(new Uint8Array(randomBytes(size)));
  }

  // Hash original data for integrity verification
  const allPlain = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of plainChunks) {
    allPlain.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const originalHash = await hashBuffer(allPlain.buffer.slice(allPlain.byteOffset, allPlain.byteOffset + allPlain.byteLength) as ArrayBuffer);

  const genMs = performance.now() - genStart;
  timings.push({ label: "Generate + hash", durationMs: genMs, bytes: totalBytes });
  console.log(`  Done in ${formatDuration(genMs)} (SHA-256: ${originalHash.slice(0, 16)}...)\n`);

  // === 2. ENCRYPT ===
  console.log("Encrypting chunks...");
  const encStart = performance.now();

  const fek = await generateFEK();
  const masterKey = await generateMasterKey();
  const wrappedFek = await wrapKey(fek, masterKey);
  const encryptedFEK = toBase64(wrappedFek.data);
  const fekIv = toBase64(wrappedFek.iv);

  const encryptedChunks: Uint8Array[] = [];
  for (const chunk of plainChunks) {
    const encrypted = await encryptChunk(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer, fek);
    encryptedChunks.push(new Uint8Array(encrypted));
  }

  const encMs = performance.now() - encStart;
  const encryptedSize = encryptedChunks.reduce((sum, c) => sum + c.byteLength, 0);
  timings.push({ label: "Encrypt", durationMs: encMs, bytes: totalBytes });
  console.log(`  Done in ${formatDuration(encMs)} (${throughput(totalBytes, encMs)})`);
  console.log(`  Overhead: +${formatBytes(encryptedSize - totalBytes)} (IV + auth tag)\n`);

  // === 3. UPLOAD (through API) ===
  console.log(`Uploading through API (concurrency: ${concurrency})...`);

  // Init upload via GraphQL
  const { initUpload } = await gql<{ initUpload: { fileId: string } }>(INIT_UPLOAD, {
    name: `benchmark_${Date.now()}.bin`,
    mimeType: "application/octet-stream",
    size: totalBytes.toString(),
    chunkSize,
    chunkCount,
    encryptedFEK,
    fekIv,
  });
  const fileId = initUpload.fileId;
  console.log(`  File ID: ${fileId}`);

  const sink = new NodeChunkSink();

  const chunkUploadTimes: number[] = new Array(chunkCount);
  const uploadProgress = { count: 0, bytes: 0 };
  const uploadStart = performance.now();
  const uploadTicker = startTicker("Upload", chunkCount, uploadProgress, uploadStart);

  // Upload already-encrypted chunks directly via sink (skip engine encryption)
  const uploadTasks = encryptedChunks.map((encrypted, i) => async () => {
    const chunkStart = performance.now();
    await sink.upload(fileId, i, encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer);
    chunkUploadTimes[i] = performance.now() - chunkStart;
    uploadProgress.count++;
    uploadProgress.bytes += plainChunks[i].byteLength;
  });

  // Worker pool
  let uploadNextIdx = 0;
  async function uploadWorker() {
    while (uploadNextIdx < uploadTasks.length) {
      const idx = uploadNextIdx++;
      await uploadTasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunkCount) }, () => uploadWorker()));
  clearInterval(uploadTicker);

  const uploadMs = performance.now() - uploadStart;
  timings.push({ label: "Upload (API)", durationMs: uploadMs, bytes: totalBytes });
  process.stdout.write(`\r  Upload: ${chunkCount}/${chunkCount} (100%) — ${throughput(totalBytes, uploadMs)}    \n`);

  // Finalize
  const { finalizeUpload } = await gql<{
    finalizeUpload: { success: boolean; missingChunks?: number[] };
  }>(FINALIZE_UPLOAD, { fileId, sha256: originalHash });

  if (!finalizeUpload.success) {
    console.error(`  FAILED: Missing chunks: ${finalizeUpload.missingChunks?.join(", ")}`);
    process.exit(1);
  }
  console.log(`  Upload complete: ${formatDuration(uploadMs)} (${throughput(totalBytes, uploadMs)})\n`);

  // === 4. DOWNLOAD (through API) ===
  console.log(`Downloading through API (concurrency: ${concurrency})...`);

  const source = new NodeChunkSource();
  const chunkDownloadTimes: number[] = new Array(chunkCount);
  const downloadProgress = { count: 0, bytes: 0 };
  const downloadStart = performance.now();
  const downloadTicker = startTicker("Download", chunkCount, downloadProgress, downloadStart);

  const downloadedEncrypted: ArrayBuffer[] = new Array(chunkCount);

  const downloadTasks = Array.from({ length: chunkCount }, (_, i) => async () => {
    const chunkStart = performance.now();
    downloadedEncrypted[i] = await source.fetch(fileId, i);
    chunkDownloadTimes[i] = performance.now() - chunkStart;
    downloadProgress.count++;
    downloadProgress.bytes += downloadedEncrypted[i].byteLength;
  });

  let downloadNextIdx = 0;
  async function downloadWorker() {
    while (downloadNextIdx < downloadTasks.length) {
      const idx = downloadNextIdx++;
      await downloadTasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunkCount) }, () => downloadWorker()));
  clearInterval(downloadTicker);

  const downloadedBytes = downloadedEncrypted.reduce((sum, c) => sum + c.byteLength, 0);
  const downloadMs = performance.now() - downloadStart;
  timings.push({ label: "Download (API)", durationMs: downloadMs, bytes: downloadedBytes });
  process.stdout.write(`\r  Download: ${chunkCount}/${chunkCount} (100%) — ${throughput(downloadedBytes, downloadMs)}    \n`);
  console.log(`  Download complete: ${formatDuration(downloadMs)} (${throughput(downloadedBytes, downloadMs)})\n`);

  // === 5. DECRYPT & VERIFY ===
  console.log("Decrypting and verifying integrity...");
  const decStart = performance.now();

  const decryptedChunks: ArrayBuffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const decrypted = await decryptChunk(downloadedEncrypted[i], fek);
    decryptedChunks.push(decrypted);
  }

  // Reassemble and hash
  const reassembledSize = decryptedChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const reassembled = new Uint8Array(reassembledSize);
  let rOffset = 0;
  for (const chunk of decryptedChunks) {
    reassembled.set(new Uint8Array(chunk), rOffset);
    rOffset += chunk.byteLength;
  }

  const downloadHash = await hashBuffer(reassembled.buffer.slice(reassembled.byteOffset, reassembled.byteOffset + reassembled.byteLength) as ArrayBuffer);

  const decMs = performance.now() - decStart;
  timings.push({ label: "Decrypt + verify", durationMs: decMs, bytes: reassembledSize });

  const integrityOk = downloadHash === originalHash;
  console.log(`  Decrypt: ${formatDuration(decMs)} (${throughput(reassembledSize, decMs)})`);
  console.log(`  Integrity: ${integrityOk ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`    Original:   ${originalHash.slice(0, 32)}...`);
  console.log(`    Downloaded: ${downloadHash.slice(0, 32)}...`);
  if (!integrityOk) {
    console.error("\n  INTEGRITY CHECK FAILED! Data corruption detected.\n");
  }
  console.log();

  // === 6. CLEANUP ===
  console.log("Cleaning up (deleting file from Discord + DB)...");
  const deleteStart = performance.now();

  await gql(DELETE_FILE, { fileId });

  const deleteMs = performance.now() - deleteStart;
  timings.push({ label: "Cleanup (delete)", durationMs: deleteMs });
  console.log(`  Done in ${formatDuration(deleteMs)}\n`);

  // === 7. REPORT ===
  printSummary(timings);
  printChunkStats("upload:", chunkUploadTimes);
  printChunkStats("download:", chunkDownloadTimes);

  // Pipeline throughput (encrypt → upload → download → decrypt)
  const pipelineMs = (timings.find((t) => t.label === "Encrypt")?.durationMs ?? 0) +
    (timings.find((t) => t.label === "Upload (API)")?.durationMs ?? 0) +
    (timings.find((t) => t.label === "Download (API)")?.durationMs ?? 0) +
    (timings.find((t) => t.label === "Decrypt + verify")?.durationMs ?? 0);

  console.log(`\n  Pipeline throughput:  ${throughput(totalBytes, pipelineMs)} (encrypt→upload→download→decrypt)`);
  console.log("\n═══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("E2E Benchmark failed:", err);
  process.exit(1);
});
