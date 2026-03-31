#!/usr/bin/env npx tsx
// DiscorDrive v4 — Discord-only Benchmark
// Tests upload → download → delete pipeline directly against Discord webhooks.
// Measures raw Discord throughput without API server or encryption overhead.
//
// Usage: npx tsx scripts/benchmark.ts [fileSize] [concurrency]
// fileSize accepts: 100 (MB), 100MB, 2GB, 500KB, 2.5GB
// Default file size: 25 MB
// Default concurrency: number of configured webhooks
//
// Requires: WEBHOOK_1 (and optionally more) in .env, running PostgreSQL.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { serverConfig } from "@discordrive/config/server";
import { parseWebhookUrls, WebhookRateLimiter, uploadChunk, getChunkUrl, streamChunk, deleteChunk } from "@discordrive/discord-client";
import { config } from "@discordrive/config";
import {
  formatBytes,
  formatDuration,
  throughput,
  parseSize,
  runPool,
  startTicker,
  newDiagStats,
  printDiagStats,
  printSummary,
  printChunkStats,
  type TimingResult,
} from "./bench-utils.js";

// === Main ===

async function main() {
  const totalBytes = parseSize(process.argv[2] ?? "25");
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(totalBytes / chunkSize);

  // Parse webhooks
  const webhooks = parseWebhookUrls(serverConfig.webhooks);
  if (webhooks.length === 0) {
    console.error("\n  ERROR: No webhooks configured. Set WEBHOOK_1, WEBHOOK_2, ... in .env");
    process.exit(1);
  }

  const concurrency = parseInt(process.argv[3] ?? String(webhooks.length), 10);

  console.log("═══════════════════════════════════════════");
  console.log("  DiscorDrive Benchmark (Discord-only)");
  console.log("═══════════════════════════════════════════");
  console.log(`  File size:    ${formatBytes(totalBytes)}`);
  console.log(`  Chunk size:   ${formatBytes(chunkSize)}`);
  console.log(`  Chunk count:  ${chunkCount}`);
  console.log(`  Webhooks:     ${webhooks.length}`);
  console.log(`  Concurrency:  ${concurrency}`);
  console.log("═══════════════════════════════════════════\n");

  const rateLimiter = new WebhookRateLimiter();
  const timings: TimingResult[] = [];
  const webhookIds = webhooks.map((w) => w.id);

  // Generate test data
  console.log("Generating random test data...");
  const genStart = performance.now();
  const chunks: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const size = Math.min(chunkSize, totalBytes - i * chunkSize);
    chunks.push(randomBytes(size));
  }
  const genMs = performance.now() - genStart;
  timings.push({ label: "Generate test data", durationMs: genMs, bytes: totalBytes });
  console.log(`  Done in ${formatDuration(genMs)}\n`);

  // === UPLOAD ===
  console.log(`Uploading ${chunkCount} chunks (concurrency: ${concurrency})...`);
  const uploadResults: Array<{ messageId: string; channelId: string; webhookId: string }> = new Array(chunkCount);
  const chunkUploadTimes: number[] = new Array(chunkCount);
  const uploadDiag = newDiagStats();
  const uploadProgress = { count: 0, bytes: 0 };
  const uploadStart = performance.now();
  const uploadTicker = startTicker("Upload", chunkCount, uploadProgress, uploadStart);

  const uploadTasks = chunks.map((chunk, i) => async () => {
    const chunkStart = performance.now();

    const availableId = await rateLimiter.waitForAvailable(webhookIds);
    const selectedWebhook = webhooks.find((w) => w.id === availableId)!;

    // Track rate-limit wait time
    const waitMs = performance.now() - chunkStart;
    if (waitMs > 200) uploadDiag.rateLimitWaits++;

    const result = await uploadChunk(
      selectedWebhook,
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
      `bench_chunk_${i}.bin`,
      rateLimiter,
    );

    const chunkMs = performance.now() - chunkStart;
    chunkUploadTimes[i] = chunkMs;

    uploadResults[i] = {
      messageId: result.messageId,
      channelId: result.channelId,
      webhookId: selectedWebhook.id,
    };

    // Diagnostics
    uploadDiag.webhookChunks.set(selectedWebhook.id, (uploadDiag.webhookChunks.get(selectedWebhook.id) ?? 0) + 1);
    uploadProgress.count++;
    uploadProgress.bytes += chunk.byteLength;
  });

  await runPool(uploadTasks, concurrency);
  clearInterval(uploadTicker);

  const uploadMs = performance.now() - uploadStart;
  timings.push({ label: "Upload total", durationMs: uploadMs, bytes: totalBytes });
  process.stdout.write(`\r  Upload: ${chunkCount}/${chunkCount} (100%) — ${throughput(totalBytes, uploadMs)}    \n`);
  console.log(`  Upload complete: ${formatDuration(uploadMs)} (${throughput(totalBytes, uploadMs)})`);
  printDiagStats(uploadDiag, "Upload");
  console.log();

  // === DOWNLOAD ===
  console.log(`Downloading ${chunkCount} chunks (concurrency: ${concurrency})...`);
  const chunkDownloadTimes: number[] = new Array(chunkCount);
  const downloadDiag = newDiagStats();
  const downloadProgress = { count: 0, bytes: 0 };
  const downloadStart = performance.now();
  const downloadTicker = startTicker("Download", chunkCount, downloadProgress, downloadStart);
  let downloadedBytes = 0;

  const downloadTasks = uploadResults.map((uploadInfo, i) => async () => {
    const chunkStart = performance.now();
    const webhook = webhooks.find((w) => w.id === uploadInfo.webhookId)!;

    // Get fresh CDN URL (rate-limited Discord API call)
    const cdnUrl = await getChunkUrl(webhook, uploadInfo.messageId, rateLimiter);

    // Stream chunk from CDN (NOT rate-limited)
    const stream = await streamChunk(cdnUrl);
    const reader = stream.getReader();
    const downloadedChunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedChunks.push(value);
    }

    const chunkMs = performance.now() - chunkStart;
    chunkDownloadTimes[i] = chunkMs;

    const chunkBytes = downloadedChunks.reduce((sum, c) => sum + c.length, 0);
    downloadedBytes += chunkBytes;

    downloadDiag.webhookChunks.set(webhook.id, (downloadDiag.webhookChunks.get(webhook.id) ?? 0) + 1);
    downloadProgress.count++;
    downloadProgress.bytes += chunkBytes;
  });

  await runPool(downloadTasks, concurrency);
  clearInterval(downloadTicker);

  const downloadMs = performance.now() - downloadStart;
  timings.push({ label: "Download total", durationMs: downloadMs, bytes: downloadedBytes });
  process.stdout.write(`\r  Download: ${chunkCount}/${chunkCount} (100%) — ${throughput(downloadedBytes, downloadMs)}    \n`);
  console.log(`  Download complete: ${formatDuration(downloadMs)} (${throughput(downloadedBytes, downloadMs)})`);
  printDiagStats(downloadDiag, "Download");
  console.log();

  // === DELETE ===
  // DELETE endpoint has stricter rate limits than POST/GET — use lower concurrency
  const deleteConcurrency = Math.min(5, webhooks.length);
  console.log(`Deleting ${chunkCount} messages (concurrency: ${deleteConcurrency})...`);
  const deleteProgress = { count: 0, bytes: 0 };
  const deleteStart = performance.now();
  const deleteTicker = startTicker("Delete", chunkCount, deleteProgress, deleteStart);

  const deleteTasks = uploadResults.map((uploadInfo) => async () => {
    await rateLimiter.waitForAvailable(webhookIds);
    const webhook = webhooks.find((w) => w.id === uploadInfo.webhookId)!;
    await deleteChunk(webhook, uploadInfo.messageId, rateLimiter);
    deleteProgress.count++;
  });

  await runPool(deleteTasks, deleteConcurrency);
  clearInterval(deleteTicker);

  const deleteMs = performance.now() - deleteStart;
  timings.push({ label: "Delete total", durationMs: deleteMs });
  process.stdout.write(`\r  Delete: ${chunkCount}/${chunkCount} (100%)    \n`);
  console.log(`  Delete complete: ${formatDuration(deleteMs)}\n`);

  // === SUMMARY ===
  printSummary(timings);
  printChunkStats("upload:", chunkUploadTimes);
  printChunkStats("download:", chunkDownloadTimes);

  console.log("\n═══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
