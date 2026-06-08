#!/usr/bin/env npx tsx
// DiscorDrive v4 — Webhooks vs. Webhooks+Bots Benchmark
//
// Runs two passes with the same generated data:
//   Pass 1: webhooks only (baseline)
//   Pass 2: webhooks + bot tokens (combined sender pool)
//
// Usage: npx tsx scripts/benchmark-bots.ts [fileSize]
// Requires: WEBHOOK_1..N and BOT_1..N in .env

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { serverConfig } from "@ddv4/config/server";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  uploadChunk,
  getChunkUrl,
  streamChunk,
  deleteChunk,
  type WebhookInfo,
} from "@ddv4/discord-client";
import { config } from "@ddv4/config";
import {
  formatBytes,
  formatDuration,
  throughput,
  parseSize,
  runPool,
  startTicker,
  newDiagStats,
  printDiagStats,
  printChunkStats,
  type TimingResult,
} from "./bench-utils.js";

// ─── Bot types ────────────────────────────────────────────────────────────────

interface BotInfo {
  id: string;       // e.g. "BOT_1" — used as rate-limiter key
  token: string;
  channelId: string;
}

interface UploadResultEx {
  messageId: string;
  channelId: string;
  senderId: string;
  senderType: "webhook" | "bot";
}

type Sender =
  | { type: "webhook"; info: WebhookInfo }
  | { type: "bot"; info: BotInfo };

// ─── Env parsing ──────────────────────────────────────────────────────────────

function parseBotTokens(): string[] {
  const tokens: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const t = process.env[`BOT_${i}`];
    if (t?.trim()) tokens.push(t.trim());
  }
  return tokens;
}

// ─── Webhook channel-ID resolution ───────────────────────────────────────────

async function fetchWebhookChannelId(webhook: WebhookInfo): Promise<string> {
  const resp = await fetch(
    `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) throw new Error(`Failed to fetch webhook ${webhook.id}: ${resp.status}`);
  const data = (await resp.json()) as { channel_id: string };
  return data.channel_id;
}

async function fetchBotTextChannels(token: string): Promise<string[]> {
  const guildsResp = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!guildsResp.ok) throw new Error(`Failed to fetch guilds: ${guildsResp.status}`);
  const guilds = (await guildsResp.json()) as Array<{ id: string; name: string }>;
  if (guilds.length === 0) throw new Error("Bot is not in any guild");

  // Use the first guild (bots are expected to share a guild for benchmark)
  const guildId = guilds[0].id;
  const channelsResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!channelsResp.ok) throw new Error(`Failed to fetch channels: ${channelsResp.status}`);
  const channels = (await channelsResp.json()) as Array<{ id: string; type: number }>;
  return channels.filter((c) => c.type === 0).map((c) => c.id); // type 0 = text channel
}

async function initBots(tokens: string[], _webhooks: WebhookInfo[]): Promise<BotInfo[]> {
  if (tokens.length === 0) return [];

  console.log("  Resolving bot channels from guild…");
  let channelIds: string[];
  try {
    channelIds = await fetchBotTextChannels(tokens[0]);
  } catch (err) {
    console.log(`  WARNING: Could not resolve bot channels: ${err}`);
    return [];
  }

  if (channelIds.length === 0) {
    console.log("  WARNING: No text channels found for bots");
    return [];
  }

  const bots: BotInfo[] = tokens.map((token, i) => ({
    id: `BOT_${i + 1}`,
    token,
    // Each bot gets its own channel to avoid shared per-channel rate limit bucket
    channelId: channelIds[i % channelIds.length],
  }));

  console.log(`  Assigned ${bots.length} bots across ${Math.min(bots.length, channelIds.length)} channel(s)\n`);
  return bots;
}

// ─── Bot API helpers ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function uploadChunkBot(
  bot: BotInfo,
  data: ArrayBuffer,
  filename: string,
  rateLimiter: WebhookRateLimiter,
): Promise<{ messageId: string; channelId: string }> {
  const url = `https://discord.com/api/v10/channels/${bot.channelId}/messages`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    rateLimiter.reserve(bot.id);
    const form = new FormData();
    form.append("file", new Blob([data], { type: "application/octet-stream" }), filename);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bot ${bot.token}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      rateLimiter.release(bot.id);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Bot upload timed out for ${filename}`);
      }
      throw err;
    }

    rateLimiter.release(bot.id);
    rateLimiter.recordResponse(bot.id, response.headers);

    if (response.ok) {
      const json = (await response.json()) as { id: string; channel_id: string };
      return { messageId: json.id, channelId: json.channel_id };
    }

    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      await new Promise((r) => setTimeout(r, retryAfter ? parseFloat(retryAfter) * 1000 : 5000));
      continue;
    }
    if (response.status === 413) throw new Error("CHUNK_TOO_LARGE");
    if (response.status === 401 || response.status === 403) {
      const txt = await response.text();
      throw new Error(`AUTH_ERROR: ${bot.id} got ${response.status}: ${txt}`);
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    const txt = await response.text();
    throw new Error(`Bot upload failed: ${response.status} — ${txt}`);
  }
  throw new Error(`Bot upload failed after ${MAX_RETRIES} retries`);
}

async function getChunkUrlBot(
  bot: BotInfo,
  messageId: string,
  channelId: string,
  rateLimiter: WebhookRateLimiter,
): Promise<string> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bot ${bot.token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Bot getChunkUrl timed out for ${messageId}`);
      }
      throw err;
    }

    rateLimiter.recordResponse(bot.id, response.headers);

    if (response.ok) {
      const msg = (await response.json()) as { attachments: Array<{ url: string }> };
      if (!msg.attachments.length) throw new Error(`No attachments on message ${messageId}`);
      return msg.attachments[0].url;
    }

    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      await new Promise((r) => setTimeout(r, retryAfter ? parseFloat(retryAfter) * 1000 : 5000));
      continue;
    }
    if (response.status === 404) throw new Error(`Message ${messageId} not found`);
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Bot getChunkUrl failed: ${response.status}`);
  }
  throw new Error(`Bot getChunkUrl failed after ${MAX_RETRIES} retries`);
}

async function deleteChunkBot(
  bot: BotInfo,
  messageId: string,
  channelId: string,
  rateLimiter: WebhookRateLimiter,
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bot ${bot.token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Bot delete timed out for ${messageId}`);
      }
      throw err;
    }

    rateLimiter.recordResponse(bot.id, response.headers);

    if (response.ok || response.status === 204) return;
    if (response.status === 404) return; // already gone
    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      await new Promise((r) => setTimeout(r, retryAfter ? parseFloat(retryAfter) * 1000 : 5000));
      continue;
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Bot delete failed: ${response.status}`);
  }
  throw new Error(`Bot delete failed after ${MAX_RETRIES} retries`);
}

// ─── Core benchmark pass ──────────────────────────────────────────────────────

interface PassResult {
  uploadMbps: number;
  downloadMbps: number;
  uploadMs: number;
  downloadMs: number;
  deleteMs: number;
  totalMs: number;
  chunkUploadTimes: number[];
  chunkDownloadTimes: number[];
  webhookChunks: number;
  botChunks: number;
}

async function runPass(
  passLabel: string,
  chunks: Buffer[],
  webhooks: WebhookInfo[],
  bots: BotInfo[],
): Promise<PassResult> {
  const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
  const chunkCount = chunks.length;
  const senders: Sender[] = [
    ...webhooks.map((w) => ({ type: "webhook" as const, info: w })),
    ...bots.map((b) => ({ type: "bot" as const, info: b })),
  ];
  const concurrency = senders.length;
  const senderIds = senders.map((s) => s.info.id);
  const senderMap = new Map<string, Sender>(senders.map((s) => [s.info.id, s]));

  console.log(`\n── ${passLabel} ──────────────────────────────────`);
  console.log(`   Senders: ${webhooks.length} webhooks + ${bots.length} bots (concurrency: ${concurrency})`);

  const rateLimiter = new WebhookRateLimiter();
  const uploadResults: UploadResultEx[] = new Array(chunkCount);
  const chunkUploadTimes: number[] = new Array(chunkCount);
  const uploadDiag = newDiagStats();
  const uploadProgress = { count: 0, bytes: 0 };
  const uploadStart = performance.now();
  const uploadTicker = startTicker("Upload", chunkCount, uploadProgress, uploadStart);

  const uploadTasks = chunks.map((chunk, i) => async () => {
    const chunkStart = performance.now();
    const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
    const filename = `bench_chunk_${i}.bin`;

    const availableId = await rateLimiter.waitForAvailable(senderIds);
    const waitMs = performance.now() - chunkStart;
    if (waitMs > 200) uploadDiag.rateLimitWaits++;

    const sender = senderMap.get(availableId)!;
    let result: UploadResultEx;

    if (sender.type === "webhook") {
      const r = await uploadChunk(sender.info, data, filename, rateLimiter);
      result = { messageId: r.messageId, channelId: r.channelId, senderId: sender.info.id, senderType: "webhook" };
      uploadDiag.webhookChunks.set(sender.info.id, (uploadDiag.webhookChunks.get(sender.info.id) ?? 0) + 1);
    } else {
      const r = await uploadChunkBot(sender.info, data, filename, rateLimiter);
      result = { messageId: r.messageId, channelId: r.channelId, senderId: sender.info.id, senderType: "bot" };
      uploadDiag.webhookChunks.set(sender.info.id, (uploadDiag.webhookChunks.get(sender.info.id) ?? 0) + 1);
    }

    chunkUploadTimes[i] = performance.now() - chunkStart;
    uploadResults[i] = result;
    uploadProgress.count++;
    uploadProgress.bytes += chunk.byteLength;
  });

  await runPool(uploadTasks, concurrency);
  clearInterval(uploadTicker);
  const uploadMs = performance.now() - uploadStart;
  process.stdout.write(`\r  Upload: ${chunkCount}/${chunkCount} (100%) — ${throughput(totalBytes, uploadMs)}    \n`);
  console.log(`  Upload complete: ${formatDuration(uploadMs)} (${throughput(totalBytes, uploadMs)})`);
  printDiagStats(uploadDiag, "Upload");

  // Distribution summary
  const webhookChunks = uploadResults.filter((r) => r.senderType === "webhook").length;
  const botChunks = uploadResults.filter((r) => r.senderType === "bot").length;
  if (bots.length > 0) {
    console.log(`\n  Sender distribution: ${webhookChunks} webhook chunks, ${botChunks} bot chunks`);
  }

  // === DOWNLOAD ===
  console.log(`\nDownloading ${chunkCount} chunks (concurrency: ${concurrency})...`);
  const chunkDownloadTimes: number[] = new Array(chunkCount);
  const downloadDiag = newDiagStats();
  const downloadProgress = { count: 0, bytes: 0 };
  const downloadStart = performance.now();
  const downloadTicker = startTicker("Download", chunkCount, downloadProgress, downloadStart);
  let downloadedBytes = 0;

  const downloadTasks = uploadResults.map((uploadInfo, i) => async () => {
    const chunkStart = performance.now();
    const sender = senderMap.get(uploadInfo.senderId)!;

    let cdnUrl: string;
    if (sender.type === "webhook") {
      cdnUrl = await getChunkUrl(sender.info, uploadInfo.messageId, rateLimiter);
    } else {
      cdnUrl = await getChunkUrlBot(sender.info, uploadInfo.messageId, uploadInfo.channelId, rateLimiter);
    }

    const stream = await streamChunk(cdnUrl);
    const reader = stream.getReader();
    let chunkBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkBytes += value.length;
    }

    chunkDownloadTimes[i] = performance.now() - chunkStart;
    downloadedBytes += chunkBytes;
    downloadDiag.webhookChunks.set(uploadInfo.senderId, (downloadDiag.webhookChunks.get(uploadInfo.senderId) ?? 0) + 1);
    downloadProgress.count++;
    downloadProgress.bytes += chunkBytes;
  });

  await runPool(downloadTasks, concurrency);
  clearInterval(downloadTicker);
  const downloadMs = performance.now() - downloadStart;
  process.stdout.write(`\r  Download: ${chunkCount}/${chunkCount} (100%) — ${throughput(downloadedBytes, downloadMs)}    \n`);
  console.log(`  Download complete: ${formatDuration(downloadMs)} (${throughput(downloadedBytes, downloadMs)})`);
  printDiagStats(downloadDiag, "Download");

  // === DELETE ===
  const deleteConcurrency = Math.min(5, senders.length);
  console.log(`\nDeleting ${chunkCount} messages (concurrency: ${deleteConcurrency})...`);
  const deleteProgress = { count: 0, bytes: 0 };
  const deleteStart = performance.now();
  const deleteTicker = startTicker("Delete", chunkCount, deleteProgress, deleteStart);

  const deleteTasks = uploadResults.map((uploadInfo) => async () => {
    const sender = senderMap.get(uploadInfo.senderId)!;
    if (sender.type === "webhook") {
      await rateLimiter.waitForAvailable([sender.info.id]);
      await deleteChunk(sender.info, uploadInfo.messageId, rateLimiter);
    } else {
      await deleteChunkBot(sender.info, uploadInfo.messageId, uploadInfo.channelId, rateLimiter);
    }
    deleteProgress.count++;
  });

  await runPool(deleteTasks, deleteConcurrency);
  clearInterval(deleteTicker);
  const deleteMs = performance.now() - deleteStart;
  process.stdout.write(`\r  Delete: ${chunkCount}/${chunkCount} (100%)    \n`);
  console.log(`  Delete complete: ${formatDuration(deleteMs)}\n`);

  printChunkStats("upload:", chunkUploadTimes);
  printChunkStats("download:", chunkDownloadTimes);

  const totalMs = uploadMs + downloadMs + deleteMs;
  return {
    uploadMbps: (totalBytes / (1024 * 1024)) / (uploadMs / 1000),
    downloadMbps: (downloadedBytes / (1024 * 1024)) / (downloadMs / 1000),
    uploadMs,
    downloadMs,
    deleteMs,
    totalMs,
    chunkUploadTimes,
    chunkDownloadTimes,
    webhookChunks,
    botChunks,
  };
}

// ─── Comparison printer ───────────────────────────────────────────────────────

function pctDelta(a: number, b: number, higherIsBetter = true): string {
  if (a === 0) return "N/A";
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? "+" : "";
  const better = higherIsBetter ? pct >= 0 : pct <= 0;
  const arrow = better ? "▲" : "▼";
  return `${arrow} ${sign}${pct.toFixed(1)}%`;
}

function printComparison(r1: PassResult, r2: PassResult): void {
  const w = 14;
  const pad = (s: string) => s.padStart(w);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  COMPARISON: Webhooks only  vs.  Webhooks + Bots");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const header = `  ${"".padEnd(26)}${"Webhooks".padStart(w)}${"+ Bots".padStart(w)}${"Delta".padStart(w)}`;
  console.log(header);
  console.log(`  ${"─".repeat(26 + w * 3)}`);

  const rows: Array<[string, string, string, string]> = [
    [
      "Upload throughput",
      `${r1.uploadMbps.toFixed(2)} MB/s`,
      `${r2.uploadMbps.toFixed(2)} MB/s`,
      pctDelta(r1.uploadMbps, r2.uploadMbps, true),
    ],
    [
      "Download throughput",
      `${r1.downloadMbps.toFixed(2)} MB/s`,
      `${r2.downloadMbps.toFixed(2)} MB/s`,
      pctDelta(r1.downloadMbps, r2.downloadMbps, true),
    ],
    [
      "Upload time",
      formatDuration(r1.uploadMs),
      formatDuration(r2.uploadMs),
      pctDelta(r1.uploadMs, r2.uploadMs, false),
    ],
    [
      "Download time",
      formatDuration(r1.downloadMs),
      formatDuration(r2.downloadMs),
      pctDelta(r1.downloadMs, r2.downloadMs, false),
    ],
    [
      "Delete time",
      formatDuration(r1.deleteMs),
      formatDuration(r2.deleteMs),
      pctDelta(r1.deleteMs, r2.deleteMs, false),
    ],
    [
      "Total time",
      formatDuration(r1.totalMs),
      formatDuration(r2.totalMs),
      pctDelta(r1.totalMs, r2.totalMs, false),
    ],
  ];

  for (const [label, v1, v2, delta] of rows) {
    console.log(`  ${label.padEnd(26)}${pad(v1)}${pad(v2)}${pad(delta)}`);
  }

  console.log();
  console.log(`  Sender mix (pass 2): ${r2.webhookChunks} webhook chunks, ${r2.botChunks} bot chunks`);
  console.log("\n═══════════════════════════════════════════════════════════════");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const totalBytes = parseSize(process.argv[2] ?? "25");
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(totalBytes / chunkSize);

  const webhooks = parseWebhookUrls(serverConfig.webhooks);
  if (webhooks.length === 0) {
    console.error("ERROR: No webhooks configured. Set WEBHOOK_1, WEBHOOK_2, ... in .env");
    process.exit(1);
  }

  const botTokens = parseBotTokens();
  if (botTokens.length === 0) {
    console.error("ERROR: No bot tokens configured. Set BOT_1, BOT_2, ... in .env");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DiscorDrive — Webhooks vs. Webhooks+Bots Benchmark");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  File size:    ${formatBytes(totalBytes)}`);
  console.log(`  Chunk size:   ${formatBytes(chunkSize)}`);
  console.log(`  Chunk count:  ${chunkCount}`);
  console.log(`  Webhooks:     ${webhooks.length}`);
  console.log(`  Bots:         ${botTokens.length}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Resolve bot channel IDs
  const bots = await initBots(botTokens, webhooks);
  console.log("  Bot → channel assignments:");
  for (const b of bots) console.log(`    ${b.id} → channel ${b.channelId}`);

  // Generate test data (shared across both passes)
  console.log("\nGenerating random test data...");
  const genStart = performance.now();
  const chunks: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push(randomBytes(Math.min(chunkSize, totalBytes - i * chunkSize)));
  }
  console.log(`  Done in ${formatDuration(performance.now() - genStart)}\n`);

  // === Pass 1: Webhooks only ===
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  PASS 1 — Webhooks only               ║");
  console.log("╚═══════════════════════════════════════╝");
  const pass1 = await runPass("Webhooks only", chunks, webhooks, []);

  // Cool-down to avoid rate limit bleed between passes
  console.log("Waiting 5s before pass 2…");
  await new Promise((r) => setTimeout(r, 5000));

  // === Pass 2: Webhooks + Bots ===
  console.log("\n╔═══════════════════════════════════════╗");
  console.log("║  PASS 2 — Webhooks + Bots             ║");
  console.log("╚═══════════════════════════════════════╝");
  const pass2 = await runPass("Webhooks + Bots", chunks, webhooks, bots);

  // === Comparison ===
  printComparison(pass1, pass2);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
