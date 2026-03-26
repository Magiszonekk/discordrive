#!/usr/bin/env npx tsx
// DiscorDrive v4 — Benchmark script
// Tests upload → download → delete pipeline and measures timing.
//
// Usage: npx tsx scripts/benchmark.ts [fileSize] [concurrency] [--log <path>]
// fileSize accepts: 100 (MB), 100MB, 2GB, 500KB, 2.5GB
// Default file size: 25 MB
// Default concurrency: number of configured webhooks
//
// Requires: WEBHOOK_1 (and optionally more) in .env, running PostgreSQL.

import "dotenv/config";
import { randomBytes, createCipheriv, createHash } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { serverConfig } from "@ddv4/config/server";
import { parseWebhookUrls, WebhookRateLimiter, uploadChunk, getChunkUrl, streamChunk, deleteChunk } from "@ddv4/discord-client";
import { config } from "@ddv4/config";

// === Helpers ===

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}min`;
}

function throughput(bytes: number, ms: number): string {
  if (ms === 0) return "∞";
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  return `${mbps.toFixed(2)} MB/s`;
}

interface TimingResult {
  label: string;
  durationMs: number;
  bytes?: number;
}

// === Diagnostics ===

interface DiagStats {
  rateLimitWaits: number;
  http429s: number;
  webhookChunks: Map<string, number>;
  webhook429s: Map<string, number>;
}

function newDiagStats(): DiagStats {
  return {
    rateLimitWaits: 0,
    http429s: 0,
    webhookChunks: new Map(),
    webhook429s: new Map(),
  };
}

function printDiagStats(stats: DiagStats, label: string): void {
  console.log(`\n  ${label} diagnostics:`);
  console.log(`    Rate-limit waits:  ${stats.rateLimitWaits}`);
  console.log(`    HTTP 429s:         ${stats.http429s}`);
  if (stats.webhookChunks.size > 0) {
    console.log(`    Per-webhook chunks:`);
    for (const [id, count] of stats.webhookChunks) {
      const short = id.slice(-6);
      const n429 = stats.webhook429s.get(id) ?? 0;
      console.log(`      ...${short}: ${count} chunks${n429 > 0 ? `, ${n429} 429s` : ""}`);
    }
  }
}

// === Worker pool ===

async function runPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx;
      if (idx >= tasks.length) break;
      nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// === Progress ticker ===

function startTicker(
  label: string,
  totalChunks: number,
  completedRef: { count: number; bytes: number },
  startTime: number,
): NodeJS.Timeout {
  return setInterval(() => {
    const elapsed = performance.now() - startTime;
    const pct = Math.round((completedRef.count / totalChunks) * 100);
    const rate = completedRef.bytes > 0
      ? throughput(completedRef.bytes, elapsed)
      : `${(completedRef.count / (elapsed / 1000)).toFixed(1)} msgs/s`;
    process.stdout.write(`\r  ${label}: ${completedRef.count}/${totalChunks} (${pct}%) — ${rate}    `);
  }, 500);
}

// === Size parser ===

function parseSize(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
  if (!match) {
    console.error(`  ERROR: Invalid size "${input}". Examples: 100, 100MB, 2GB, 500KB`);
    process.exit(1);
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? "MB").toUpperCase();
  const multipliers: Record<string, number> = {
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(value * multipliers[unit]);
}

// === Hardware Diagnostics ===

interface HardwareResults {
  cpu: string;
  cores: number;
  ramGB: number;
  diskReadMBps: number;
  aesGcmMBps: number;
  sha256MBps: number;
  memAllocMBps: number;
}

function runHardwareBenchmark(): HardwareResults {
  const cpuInfo = cpus();
  const cpu = cpuInfo[0]?.model ?? "Unknown";
  const cores = cpuInfo.length;
  const ramGB = Math.round(totalmem() / (1024 ** 3));

  // Disk sequential read
  const diskTestSize = 50 * 1024 * 1024; // 50MB
  const tmpPath = join(tmpdir(), `ddv4-bench-${Date.now()}.bin`);
  const diskBuf = randomBytes(diskTestSize);
  writeFileSync(tmpPath, diskBuf);
  // Warm up FS cache
  readFileSync(tmpPath);
  const diskStart = performance.now();
  readFileSync(tmpPath);
  const diskMs = performance.now() - diskStart;
  unlinkSync(tmpPath);
  const diskReadMBps = (diskTestSize / (1024 * 1024)) / (diskMs / 1000);

  // AES-256-GCM encryption
  const aesKey = randomBytes(32);
  const aesIv = randomBytes(12);
  const aesData = randomBytes(10 * 1024 * 1024); // 10MB (= 1 chunk)
  const aesIterations = 5;
  const aesStart = performance.now();
  for (let i = 0; i < aesIterations; i++) {
    const cipher = createCipheriv("aes-256-gcm", aesKey, aesIv);
    cipher.update(aesData);
    cipher.final();
    cipher.getAuthTag();
  }
  const aesMs = performance.now() - aesStart;
  const aesTotalBytes = 10 * 1024 * 1024 * aesIterations;
  const aesGcmMBps = (aesTotalBytes / (1024 * 1024)) / (aesMs / 1000);

  // SHA-256 hashing
  const hashData = randomBytes(50 * 1024 * 1024); // 50MB
  const hashStart = performance.now();
  createHash("sha256").update(hashData).digest("hex");
  const hashMs = performance.now() - hashStart;
  const sha256MBps = (50 * 1024 * 1024 / (1024 * 1024)) / (hashMs / 1000);

  // Memory allocation
  const allocCount = 20;
  const allocSize = 10 * 1024 * 1024; // 10MB
  const allocStart = performance.now();
  for (let i = 0; i < allocCount; i++) {
    const buf = Buffer.alloc(allocSize);
    buf[0] = 1; // prevent optimization
  }
  const allocMs = performance.now() - allocStart;
  const allocTotalMB = (allocCount * allocSize) / (1024 * 1024);
  const memAllocMBps = allocTotalMB / (allocMs / 1000);

  return { cpu, cores, ramGB, diskReadMBps, aesGcmMBps, sha256MBps, memAllocMBps };
}

function printHardwareResults(hw: HardwareResults): void {
  console.log("═══════════════════════════════════════════");
  console.log("  Hardware Diagnostics");
  console.log("═══════════════════════════════════════════");
  console.log(`  CPU:          ${hw.cpu} (${hw.cores} cores)`);
  console.log(`  RAM:          ${hw.ramGB} GB`);
  console.log(`  Disk read:    ${hw.diskReadMBps.toFixed(1)} MB/s`);
  console.log(`  AES-GCM:      ${hw.aesGcmMBps.toFixed(1)} MB/s (10MB × 5)`);
  console.log(`  SHA-256:      ${hw.sha256MBps.toFixed(1)} MB/s`);
  console.log(`  Mem alloc:    ${hw.memAllocMBps.toFixed(1)} MB/s (10MB × 20)`);
  console.log("═══════════════════════════════════════════\n");
}

// === Main ===

async function main() {
  // Parse --log flag
  const logIdx = process.argv.indexOf("--log");
  const logPath = logIdx !== -1 && process.argv[logIdx + 1] ? process.argv[logIdx + 1] : null;

  // Filter --log and its value from positional args
  const positionalArgs = process.argv.slice(2).filter((_, i) => {
    const absI = i + 2;
    return absI !== logIdx && absI !== logIdx + 1;
  });

  const totalBytes = parseSize(positionalArgs[0] ?? "25");
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(totalBytes / chunkSize);

  // Parse webhooks
  const webhooks = parseWebhookUrls(serverConfig.webhooks);
  if (webhooks.length === 0) {
    console.error("\n  ERROR: No webhooks configured. Set WEBHOOK_1, WEBHOOK_2, ... in .env");
    process.exit(1);
  }

  const concurrency = parseInt(positionalArgs[1] ?? String(webhooks.length), 10);

  // Run hardware diagnostics
  console.log("Running hardware diagnostics...\n");
  const hwResults = runHardwareBenchmark();
  printHardwareResults(hwResults);

  console.log("═══════════════════════════════════════════");
  console.log("  DiscorDrive Benchmark");
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
  const totalMs = timings.reduce((sum, t) => sum + t.durationMs, 0);

  console.log("═══════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════");
  console.log();

  for (const t of timings) {
    const tp = t.bytes ? ` (${throughput(t.bytes, t.durationMs)})` : "";
    console.log(`  ${t.label.padEnd(22)} ${formatDuration(t.durationMs).padStart(10)}${tp}`);
  }

  console.log(`  ${"─".repeat(42)}`);
  console.log(`  ${"Total".padEnd(22)} ${formatDuration(totalMs).padStart(10)}`);
  console.log();

  // Per-chunk stats
  const validUploadTimes = chunkUploadTimes.filter((t) => t !== undefined);
  const validDownloadTimes = chunkDownloadTimes.filter((t) => t !== undefined);

  if (validUploadTimes.length > 0) {
    const avgUp = validUploadTimes.reduce((a, b) => a + b, 0) / validUploadTimes.length;
    const minUp = Math.min(...validUploadTimes);
    const maxUp = Math.max(...validUploadTimes);

    const avgDown = validDownloadTimes.reduce((a, b) => a + b, 0) / validDownloadTimes.length;
    const minDown = Math.min(...validDownloadTimes);
    const maxDown = Math.max(...validDownloadTimes);

    console.log("  Per-chunk upload:  " +
      `avg=${formatDuration(avgUp)}, min=${formatDuration(minUp)}, max=${formatDuration(maxUp)}`);
    console.log("  Per-chunk download:" +
      `avg=${formatDuration(avgDown)}, min=${formatDuration(minDown)}, max=${formatDuration(maxDown)}`);
  }

  console.log("\n═══════════════════════════════════════════");

  // Write JSON results to file if --log was specified
  if (logPath) {
    const { writeFileSync: writeLog } = await import("node:fs");
    const { resolve } = await import("node:path");

    const result = {
      timestamp: new Date().toISOString(),
      hardware: {
        cpu: hwResults.cpu,
        cores: hwResults.cores,
        ramGB: hwResults.ramGB,
        diskReadMBps: parseFloat(hwResults.diskReadMBps.toFixed(1)),
        aesGcmMBps: parseFloat(hwResults.aesGcmMBps.toFixed(1)),
        sha256MBps: parseFloat(hwResults.sha256MBps.toFixed(1)),
        memAllocMBps: parseFloat(hwResults.memAllocMBps.toFixed(1)),
      },
      config: {
        totalBytes,
        chunkSize,
        chunkCount,
        webhooks: webhooks.length,
        concurrency,
      },
      timings: timings.map((t) => ({
        label: t.label,
        durationMs: Math.round(t.durationMs),
        bytes: t.bytes ?? null,
        throughputMBps: t.bytes
          ? parseFloat(((t.bytes / (1024 * 1024)) / (t.durationMs / 1000)).toFixed(2))
          : null,
      })),
      perChunk: {
        upload: validUploadTimes.length > 0 ? {
          avgMs: Math.round(validUploadTimes.reduce((a, b) => a + b, 0) / validUploadTimes.length),
          minMs: Math.round(Math.min(...validUploadTimes)),
          maxMs: Math.round(Math.max(...validUploadTimes)),
        } : null,
        download: validDownloadTimes.length > 0 ? {
          avgMs: Math.round(validDownloadTimes.reduce((a, b) => a + b, 0) / validDownloadTimes.length),
          minMs: Math.round(Math.min(...validDownloadTimes)),
          maxMs: Math.round(Math.max(...validDownloadTimes)),
        } : null,
      },
    };

    const fullPath = resolve(logPath);
    writeLog(fullPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`\n  Results written to ${fullPath}`);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
