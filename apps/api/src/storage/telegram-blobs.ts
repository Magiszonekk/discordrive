// DiscorDrive v4 — Telegram blob transport adapter
//
// Mirrors discord-blobs.ts: selects an available sender (bot) from config,
// uploads the ciphertext as a document, and returns placement coordinates.
// storagePath carries the stable file_id: "telegram://file/<file_id>".

import {
  TelegramRateLimiter,
  deleteMessage,
  downloadDocument,
  uploadDocument,
  type TgBotInfo,
} from "@ddv4/telegram-client";
import { serverConfig } from "@ddv4/config/server";

const STORAGE_PATH_PREFIX = "telegram://file/";

const sharedRateLimiter = new TelegramRateLimiter();
let cachedBots: TgBotInfo[] | null = null;
let roundRobinIndex = 0;

export interface TelegramBlobUploadResult {
  storagePath: string;
  messageId: string;
  chatId: string;
  senderId: string;
  attemptCount: number;
  upstreamStatus: number;
  elapsedMs: number;
}

function getConfiguredTelegramBots(): TgBotInfo[] {
  if (!cachedBots) {
    cachedBots = serverConfig.telegramBotConfigs;
  }
  if (!cachedBots.length) {
    throw new Error("Telegram blob transport requires at least one configured bot (TG_BOT_n + TG_BOT_n_CHAT)");
  }
  return cachedBots;
}

function fileIdFromStoragePath(storagePath: string): string {
  if (!storagePath.startsWith(STORAGE_PATH_PREFIX)) {
    throw new Error(`Unsupported Telegram storage path: ${storagePath}`);
  }
  return storagePath.slice(STORAGE_PATH_PREFIX.length);
}

async function selectSender(bots: TgBotInfo[]): Promise<TgBotInfo> {
  while (true) {
    for (let i = 0; i < bots.length; i++) {
      const idx = (roundRobinIndex + i) % bots.length;
      const bot = bots[idx]!;
      if (sharedRateLimiter.canUse(bot.id)) {
        roundRobinIndex = (idx + 1) % bots.length;
        return bot;
      }
    }
    const nextReset = sharedRateLimiter.getNextResetMs(bots.map((b) => b.id));
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(nextReset, 1000))));
  }
}

async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function uploadCiphertextBlobToTelegram(
  ownerUserId: string,
  blobId: string,
  bytes: ArrayBuffer | ArrayBufferView,
): Promise<TelegramBlobUploadResult> {
  const ciphertext =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bots = getConfiguredTelegramBots();
  const bot = await selectSender(bots);
  const filename = `${ownerUserId}-${blobId}.bin`;

  const upload = await uploadDocument(bot, ciphertext.slice().buffer, filename, sharedRateLimiter);
  return {
    storagePath: `${STORAGE_PATH_PREFIX}${upload.fileId}`,
    messageId: upload.messageId,
    chatId: upload.chatId,
    senderId: bot.id,
    attemptCount: upload.attemptCount,
    upstreamStatus: upload.upstreamStatus,
    elapsedMs: upload.elapsedMs,
  };
}

export async function fetchCiphertextBlobFromTelegram(
  storagePath: string,
  senderId: string,
): Promise<Uint8Array> {
  const fileId = fileIdFromStoragePath(storagePath);
  const bots = getConfiguredTelegramBots();
  // file_id is bound to the bot that uploaded it — the same sender must serve reads
  const bot = bots.find((b) => b.id === senderId);
  if (!bot) {
    throw new Error(`Telegram sender ${senderId} is not configured`);
  }
  const stream = await downloadDocument(bot, fileId, sharedRateLimiter);
  return streamToUint8Array(stream);
}

export async function deleteCiphertextBlobFromTelegram(
  messageId: string,
  senderId: string,
  chatId?: string | null,
): Promise<void> {
  const bots = getConfiguredTelegramBots();
  const bot = bots.find((b) => b.id === senderId);
  if (!bot) {
    throw new Error(`Telegram sender ${senderId} is not configured`);
  }
  await deleteMessage(bot, chatId ?? bot.chatId, messageId, sharedRateLimiter);
}

/** Number of configured Telegram senders. */
export function telegramSenderCount(): number {
  return serverConfig.telegramBotConfigs.length;
}

/** Senders currently usable (outside min-interval / retry_after windows). */
export function telegramSenderAvailability(): number {
  return serverConfig.telegramBotConfigs.filter((b) => sharedRateLimiter.canUse(b.id)).length;
}

export async function statTelegramBlob(storagePath: string): Promise<{ exists: boolean; size: number }> {
  return {
    exists: storagePath.startsWith(STORAGE_PATH_PREFIX),
    size: 0,
  };
}

export function clearTelegramBlobStore(): void {
  // Reset module-level caches so tests/config reloads see current serverConfig
  cachedBots = null;
  roundRobinIndex = 0;
}
