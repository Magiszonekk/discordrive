// DiscorDrive v4 — Telegram Bot API client (document upload/download/delete)
//
// Vanilla Bot API limits: sendDocument ≤ 50 MB, getFile download ≤ 20 MB.
// DiscorDrive chunks (≤ 10 MiB) fit both. file_id is the stable download
// handle; file_path from getFile expires (≥1 h) and must never be persisted.

import { TelegramRateLimiter } from "./rate-limiter.js";

export interface TgBotInfo {
  /** e.g. "TG_BOT_1" — rate-limiter + placement senderId key */
  id: string;
  token: string;
  /** Private channel/group the bot posts to (bot must be admin to delete). */
  chatId: string;
}

export interface TgUploadResult {
  messageId: string;
  chatId: string;
  fileId: string;
  attemptCount: number;
  upstreamStatus: number;
  elapsedMs: number;
}

interface TgApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const MAX_RETRIES = 3;

function apiUrl(bot: TgBotInfo, method: string): string {
  return `https://api.telegram.org/bot${bot.token}/${method}`;
}

function fileUrl(bot: TgBotInfo, filePath: string): string {
  return `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
}

async function parseEnvelope<T>(response: Response): Promise<TgApiEnvelope<T>> {
  try {
    return (await response.json()) as TgApiEnvelope<T>;
  } catch {
    return { ok: false, error_code: response.status, description: response.statusText };
  }
}

function retryAfterSeconds<T>(envelope: TgApiEnvelope<T>, response: Response): number {
  const fromBody = envelope.parameters?.retry_after;
  if (typeof fromBody === "number" && fromBody >= 0) return fromBody;
  const header = response.headers.get("retry-after");
  return header ? Math.max(1, parseFloat(header)) : 5;
}

export async function uploadDocument(
  bot: TgBotInfo,
  data: ArrayBuffer,
  filename: string,
  rateLimiter: TelegramRateLimiter,
): Promise<TgUploadResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const attemptStartMs = performance.now();
    rateLimiter.reserve(bot.id);

    const form = new FormData();
    form.append("chat_id", bot.chatId);
    form.append("disable_notification", "true");
    form.append("document", new Blob([data], { type: "application/octet-stream" }), filename);

    let response: Response;
    try {
      response = await fetch(apiUrl(bot, "sendDocument"), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      rateLimiter.release(bot.id);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Telegram upload timed out for ${filename}`);
      }
      throw err;
    }
    rateLimiter.release(bot.id);

    const envelope = await parseEnvelope<{
      message_id: number;
      chat?: { id: number };
      document?: { file_id: string };
    }>(response);

    if (response.ok && envelope.ok && envelope.result) {
      rateLimiter.recordSent(bot.id);
      const fileId = envelope.result.document?.file_id;
      if (!fileId) {
        // Telegram accepted the upload but didn't return a document — the
        // message is unusable as blob storage; surface loudly.
        throw new Error(`Telegram sendDocument returned no file_id for ${filename}`);
      }
      return {
        messageId: String(envelope.result.message_id),
        chatId: String(envelope.result.chat?.id ?? bot.chatId),
        fileId,
        attemptCount: attempt + 1,
        upstreamStatus: response.status,
        elapsedMs: Number((performance.now() - attemptStartMs).toFixed(2)),
      };
    }

    if (response.status === 429 || envelope.error_code === 429) {
      const waitS = retryAfterSeconds(envelope, response);
      rateLimiter.recordRetryAfter(bot.id, waitS);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    if (response.status === 413 || envelope.error_code === 413) throw new Error("CHUNK_TOO_LARGE");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AUTH_ERROR: ${bot.id} got ${response.status}: ${envelope.description ?? ""}`);
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Telegram upload failed: ${response.status} — ${envelope.description ?? "unknown error"}`);
  }
  throw new Error(`Telegram upload failed after ${MAX_RETRIES} retries`);
}

/** Resolves a fresh, short-lived file_path for a stored file_id. Never persist it. */
export async function getFilePath(
  bot: TgBotInfo,
  fileId: string,
  rateLimiter: TelegramRateLimiter,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${apiUrl(bot, "getFile")}?file_id=${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Telegram getFile timed out for ${fileId}`);
      }
      throw err;
    }

    const envelope = await parseEnvelope<{ file_path?: string }>(response);
    if (response.ok && envelope.ok && envelope.result?.file_path) {
      return envelope.result.file_path;
    }

    if (response.status === 429 || envelope.error_code === 429) {
      const waitS = retryAfterSeconds(envelope, response);
      rateLimiter.recordRetryAfter(bot.id, waitS);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    if (response.status === 400 || response.status === 404) {
      throw new Error(`Telegram file ${fileId} not found`);
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Telegram getFile failed: ${response.status} — ${envelope.description ?? "unknown error"}`);
  }
  throw new Error(`Telegram getFile failed after ${MAX_RETRIES} retries`);
}

export async function downloadDocument(
  bot: TgBotInfo,
  fileId: string,
  rateLimiter: TelegramRateLimiter,
): Promise<ReadableStream<Uint8Array>> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const filePath = await getFilePath(bot, fileId, rateLimiter);
    let response: Response;
    try {
      response = await fetch(fileUrl(bot, filePath), { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw err;
    }
    if (response.ok && response.body) return response.body;
    if ((response.status === 404 || response.status >= 500) && attempt < MAX_RETRIES) {
      // 404 can mean the file_path expired between getFile and fetch — retry re-resolves it
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  throw new Error(`Telegram download failed after ${MAX_RETRIES} retries`);
}

export async function deleteMessage(
  bot: TgBotInfo,
  chatId: string,
  messageId: string,
  rateLimiter: TelegramRateLimiter,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(apiUrl(bot, "deleteMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Telegram delete timed out for message ${messageId}`);
      }
      throw err;
    }

    const envelope = await parseEnvelope<boolean>(response);
    if (response.ok && envelope.ok) return;

    // Already gone — treat as success (mirrors Discord deleter semantics)
    if (
      response.status === 400 &&
      /message to delete not found|message can't be deleted/i.test(envelope.description ?? "")
    ) {
      return;
    }

    if (response.status === 429 || envelope.error_code === 429) {
      const waitS = retryAfterSeconds(envelope, response);
      rateLimiter.recordRetryAfter(bot.id, waitS);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    throw new Error(`Telegram delete failed for message ${messageId}: ${response.status} — ${envelope.description ?? ""}`);
  }
  throw new Error(`Telegram delete failed after ${MAX_RETRIES} retries`);
}
