#!/usr/bin/env npx tsx
// DiscorDrive v4 — API Pipeline Benchmark
//
// Tests the FULL production upload→download pipeline through the API server,
// mimicking exactly what the frontend does (encrypt → PUT /api/blob → commitManifest
// → GET /api/blob → decrypt). Runs entirely server-side so client bandwidth
// is not a bottleneck — isolates server+Discord throughput.
//
// Usage: npx tsx scripts/benchmark-api.ts [fileSize] [concurrency]
//   fileSize   default: 100MB  (e.g. 100, 500MB, 1GB)
//   concurrency default: config.defaultUploadConcurrency (20)
//
// Requires: Running API, a registered user. Set BENCH_EMAIL in .env or pass as env var.
// The login resolver does NOT check passwords, so any registered email works.

import "dotenv/config";
import { randomBytes, createHash } from "node:crypto";
import { subtle } from "node:crypto";
import { config } from "@ddv4/config";
import {
  formatBytes,
  formatDuration,
  throughput,
  parseSize,
  runPool,
  startTicker,
  printSummary,
  printChunkStats,
  type TimingResult,
} from "./bench-utils.js";

const apiPort = process.env.API_PORT ?? "3000";
const BASE_URL = `http://localhost:${apiPort}`;
const BENCH_EMAIL = process.env.BENCH_EMAIL ?? "";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

async function gql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0].message}`);
  return json.data!;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken(email: string): Promise<string> {
  const { login } = await gql<{ login: { token: string } }>(`
    mutation Login($e: String!, $p: String!) {
      login(emailOrUsername: $e, password: $p) { token }
    }
  `, { e: email, p: "benchmark" });
  return login.token;
}

// ─── Crypto (Node.js Web Crypto API — same AES-GCM as browser) ───────────────

const IV_LENGTH = 12;

async function generateFEK(): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function encryptChunk(data: ArrayBuffer, fek: CryptoKey): Promise<Uint8Array> {
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, fek, data);
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

async function decryptChunk(data: ArrayBuffer, fek: CryptoKey): Promise<Uint8Array> {
  const iv = new Uint8Array(data, 0, IV_LENGTH);
  const ct = new Uint8Array(data, IV_LENGTH);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv }, fek, ct);
  return new Uint8Array(plain);
}

// ─── Blob API ─────────────────────────────────────────────────────────────────

interface BlobUploadResponse {
  blobId: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  storageKind: string;
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}

// Colons in blobId are valid URL path characters — don't percent-encode them
// (the router matches /:blobId without decoding %3A so encoding breaks lookups).
function blobUrl(blobId: string): string {
  return `${BASE_URL}/api/blob/${blobId}`;
}

async function uploadBlob(blobId: string, data: ArrayBuffer, token: string, extraHeaders: Record<string, string> = {}): Promise<BlobUploadResponse> {
  const res = await fetch(blobUrl(blobId), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Authorization": `Bearer ${token}`, ...extraHeaders },
    body: data,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Upload ${blobId} failed: ${res.status} — ${err}`);
  }
  return res.json() as Promise<BlobUploadResponse>;
}

async function downloadBlob(blobId: string, token: string): Promise<ArrayBuffer> {
  const res = await fetch(blobUrl(blobId), {
    headers: { "Authorization": `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Download ${blobId} failed: ${res.status}`);
  return res.arrayBuffer();
}

// ─── GraphQL mutations ────────────────────────────────────────────────────────

async function initUpload(token: string, chunkCount: number, fileSize: number): Promise<string> {
  const INIT = `
    mutation Init($name: String, $mimeType: String, $wrappedFEK: String!, $total: String!, $count: Int!) {
      initUpload(name: $name, mimeType: $mimeType, wrappedFEK: $wrappedFEK,
                 totalCiphertextBytes: $total, chunkCount: $count) { fileId status }
    }
  `;
  const { initUpload: r } = await gql<{ initUpload: { fileId: string } }>(INIT, {
    name: `bench_${Date.now()}.bin`,
    mimeType: "application/octet-stream",
    wrappedFEK: "benchmark_fek",
    total: String(fileSize),
    count: chunkCount,
  }, token);
  return r.fileId;
}

async function commitManifest(
  token: string,
  fileId: string,
  blobRecords: BlobUploadResponse[],
  chunkCount: number,
  fileSize: number,
): Promise<void> {
  const COMMIT = `
    mutation Commit($fileId: ID!, $manifestBlobId: String!, $total: String!, $count: Int!, $blobs: [UploadedBlobTransportInput!]!) {
      commitManifest(fileId: $fileId, manifestBlobId: $manifestBlobId,
                     totalCiphertextBytes: $total, chunkCount: $count, blobs: $blobs) { success }
    }
  `;
  const manifestBlobId = `${fileId}:manifest`;
  const { commitManifest: r } = await gql<{ commitManifest: { success: boolean } }>(COMMIT, {
    fileId,
    manifestBlobId,
    total: String(fileSize),
    count: chunkCount,
    blobs: blobRecords,
  }, token);
  if (!r.success) throw new Error("commitManifest failed");
}

async function deleteFile(token: string, fileId: string): Promise<void> {
  const DEL = `mutation Del($id: ID!) { deleteFile(fileId: $id) }`;
  await gql(DEL, { id: fileId }, token).catch(() => {});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const totalBytes = parseSize(process.argv[2] ?? "100");
  const chunkSize = config.defaultChunkSize; // ~10 MB
  const chunkCount = Math.ceil(totalBytes / chunkSize);
  const concurrency = parseInt(process.argv[3] ?? String(config.defaultUploadConcurrency), 10);

  // Verify API
  console.log(`\nChecking API at ${BASE_URL}…`);
  try {
    const r = await fetch(`${BASE_URL}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    console.log("  API is up.\n");
  } catch {
    console.error(`  Cannot reach API at ${BASE_URL}. Is it running?`);
    process.exit(1);
  }

  // Auth
  if (!BENCH_EMAIL) {
    console.error("  Set BENCH_EMAIL env var to a registered user's email (e.g. BENCH_EMAIL=you@example.com)");
    process.exit(1);
  }
  const token = await getToken(BENCH_EMAIL);
  console.log(`  Authenticated as ${BENCH_EMAIL}\n`);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  DiscorDrive API Pipeline Benchmark (encrypt→upload→download→decrypt)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  File size:    ${formatBytes(totalBytes)}`);
  console.log(`  Chunk size:   ${formatBytes(chunkSize)}`);
  console.log(`  Chunk count:  ${chunkCount}`);
  console.log(`  Concurrency:  ${concurrency}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const timings: TimingResult[] = [];
  const fek = await generateFEK();

  // ── 1. Generate plaintext ──────────────────────────────────────────────────
  console.log("Generating plaintext data…");
  const genStart = performance.now();
  const plainChunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    plainChunks.push(new Uint8Array(randomBytes(Math.min(chunkSize, totalBytes - i * chunkSize))));
  }
  const originalHash = createHash("sha256");
  for (const c of plainChunks) originalHash.update(c);
  const originalDigest = originalHash.digest("hex");
  const genMs = performance.now() - genStart;
  timings.push({ label: "Generate plaintext", durationMs: genMs, bytes: totalBytes });
  console.log(`  Done in ${formatDuration(genMs)}\n`);

  // ── 2. Encrypt ────────────────────────────────────────────────────────────
  console.log("Encrypting chunks (AES-GCM, same as browser)…");
  const encStart = performance.now();
  const encChunks: Uint8Array[] = [];
  for (const chunk of plainChunks) {
    encChunks.push(await encryptChunk(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer, fek));
  }
  const encMs = performance.now() - encStart;
  timings.push({ label: "Encrypt", durationMs: encMs, bytes: totalBytes });
  console.log(`  Done in ${formatDuration(encMs)} (${throughput(totalBytes, encMs)})\n`);

  // ── 3. initUpload ─────────────────────────────────────────────────────────
  const fileId = await initUpload(token, chunkCount, totalBytes);
  console.log(`  File ID: ${fileId}\n`);

  // ── 4. Upload through API ─────────────────────────────────────────────────
  console.log(`Uploading ${chunkCount} chunks through API (concurrency: ${concurrency})…`);
  // blobRecords built from actual server responses — used by commitManifest
  const blobRecords: BlobUploadResponse[] = [];
  const chunkUploadTimes: number[] = new Array(chunkCount);
  const uploadProgress = { count: 0, bytes: 0 };
  const uploadStart = performance.now();
  const uploadTicker = startTicker("Upload", chunkCount, uploadProgress, uploadStart);

  const uploadTasks = encChunks.map((enc, i) => async () => {
    const t0 = performance.now();
    const blobId = `${fileId}:chunk:${i}`;
    const resp = await uploadBlob(blobId, enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer, token, {
      "X-Chunk-Index": String(i),
      "X-Chunk-Count": String(chunkCount),
    });
    chunkUploadTimes[i] = performance.now() - t0;
    blobRecords.push(resp);
    uploadProgress.count++;
    uploadProgress.bytes += plainChunks[i]!.byteLength;
  });

  await runPool(uploadTasks, concurrency);
  clearInterval(uploadTicker);
  const uploadMs = performance.now() - uploadStart;
  process.stdout.write(`\r  Upload: ${chunkCount}/${chunkCount} (100%) — ${throughput(totalBytes, uploadMs)}    \n`);
  console.log(`  Upload complete: ${formatDuration(uploadMs)} (${throughput(totalBytes, uploadMs)})\n`);
  timings.push({ label: "Upload (API+Discord)", durationMs: uploadMs, bytes: totalBytes });

  // ── 5. Upload manifest + commitManifest ───────────────────────────────────
  const manifestBlobId = `${fileId}:manifest`;
  const manifestData = randomBytes(256);
  const manifestResp = await uploadBlob(manifestBlobId, manifestData.buffer as ArrayBuffer, token);
  blobRecords.push(manifestResp);
  await commitManifest(token, fileId, blobRecords, chunkCount, totalBytes);
  console.log("  Manifest committed.\n");

  // ── 6. Download through API ───────────────────────────────────────────────
  console.log(`Downloading ${chunkCount} chunks through API (concurrency: ${concurrency})…`);
  const encDownloaded: ArrayBuffer[] = new Array(chunkCount);
  const chunkDownloadTimes: number[] = new Array(chunkCount);
  const downloadProgress = { count: 0, bytes: 0 };
  const downloadStart = performance.now();
  const downloadTicker = startTicker("Download", chunkCount, downloadProgress, downloadStart);

  const downloadTasks = Array.from({ length: chunkCount }, (_, i) => async () => {
    const t0 = performance.now();
    const blobId = `${fileId}:chunk:${i}`;
    encDownloaded[i] = await downloadBlob(blobId, token);
    chunkDownloadTimes[i] = performance.now() - t0;
    downloadProgress.count++;
    downloadProgress.bytes += encDownloaded[i].byteLength;
  });

  await runPool(downloadTasks, concurrency);
  clearInterval(downloadTicker);
  const downloadedBytes = encDownloaded.reduce((s, c) => s + c.byteLength, 0);
  const downloadMs = performance.now() - downloadStart;
  process.stdout.write(`\r  Download: ${chunkCount}/${chunkCount} (100%) — ${throughput(downloadedBytes, downloadMs)}    \n`);
  console.log(`  Download complete: ${formatDuration(downloadMs)} (${throughput(downloadedBytes, downloadMs)})\n`);
  timings.push({ label: "Download (API+Discord)", durationMs: downloadMs, bytes: downloadedBytes });

  // ── 7. Decrypt + verify ───────────────────────────────────────────────────
  console.log("Decrypting and verifying integrity…");
  const decStart = performance.now();
  const verifyHash = createHash("sha256");
  for (let i = 0; i < chunkCount; i++) {
    const plain = await decryptChunk(encDownloaded[i]!, fek);
    verifyHash.update(plain);
  }
  const verifyDigest = verifyHash.digest("hex");
  const decMs = performance.now() - decStart;
  const ok = verifyDigest === originalDigest;
  timings.push({ label: "Decrypt + verify", durationMs: decMs, bytes: totalBytes });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL (data corruption!)"} in ${formatDuration(decMs)}\n`);
  if (!ok) process.exitCode = 1;

  // ── 8. Cleanup ────────────────────────────────────────────────────────────
  console.log("Cleaning up…");
  const delStart = performance.now();
  await deleteFile(token, fileId);
  timings.push({ label: "Cleanup", durationMs: performance.now() - delStart });
  console.log(`  Done.\n`);

  // ── 9. Report ─────────────────────────────────────────────────────────────
  printSummary(timings);
  printChunkStats("upload:  ", chunkUploadTimes);
  printChunkStats("download:", chunkDownloadTimes);

  const pipelineMs = encMs + uploadMs + downloadMs + decMs;
  console.log(`\n  Full pipeline throughput:  ${throughput(totalBytes, pipelineMs)}`);
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(err => { console.error("Benchmark failed:", err); process.exit(1); });
