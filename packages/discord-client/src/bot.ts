// DiscorDrive v4 — Discord bot token upload/download

import type { WebhookRateLimiter } from "./rate-limiter.js";
import type { UploadResult } from "./uploader.js";
import { streamChunk } from "./downloader.js";

export interface BotInfo {
  id: string;       // e.g. "BOT_1" — used as rate-limiter key
  token: string;
  channelId: string;
}

const MAX_RETRIES = 3;

export async function uploadChunkBot(
  bot: BotInfo,
  data: ArrayBuffer,
  filename: string,
  rateLimiter: WebhookRateLimiter,
): Promise<UploadResult> {
  const url = `https://discord.com/api/v10/channels/${bot.channelId}/messages`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const attemptStartMs = performance.now();
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
      return {
        messageId: json.id,
        channelId: json.channel_id,
        transportPath: "bot",
        attemptCount: attempt + 1,
        upstreamStatus: response.status,
        elapsedMs: Number((performance.now() - attemptStartMs).toFixed(2)),
        relayEgress: null,
      };
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

export async function getChunkUrlBot(
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
        throw new Error(`Bot getChunkUrl timed out for message ${messageId}`);
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

export async function deleteChunkBot(
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
        throw new Error(`Bot delete timed out for message ${messageId}`);
      }
      throw err;
    }

    rateLimiter.recordResponse(bot.id, response.headers);

    if (response.ok || response.status === 204) return;

    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      await new Promise((r) => setTimeout(r, retryAfter ? parseFloat(retryAfter) * 1000 : 5000));
      continue;
    }

    // Already deleted — treat as success
    if (response.status === 404) return;

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }

    throw new Error(`Bot delete failed for message ${messageId}: ${response.status}`);
  }
  throw new Error(`Bot delete failed after ${MAX_RETRIES} retries`);
}

export async function downloadChunkBot(
  bot: BotInfo,
  messageId: string,
  channelId: string,
  rateLimiter: WebhookRateLimiter,
): Promise<ReadableStream<Uint8Array>> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const cdnUrl = await getChunkUrlBot(bot, messageId, channelId, rateLimiter);
    let response: Response;
    try {
      response = await fetch(cdnUrl, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw err;
    }
    if (response.ok && response.body) return response.body;
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Bot CDN download failed: ${response.status}`);
  }
  throw new Error(`Bot download failed after ${MAX_RETRIES} retries`);
}
