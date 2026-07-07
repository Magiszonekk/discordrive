// DiscorDrive v4 — REPLICA blob pools
//
// Physically separate sender pools used only for replication. Senders come
// from REPLICA_* env vars (different channels/servers/accounts than primary),
// so replica traffic has its own rate-limit budgets and survives loss of the
// primary account. Selection here is a plain round-robin — replica copying is
// background work and doesn't need the primary pool's tiered latency logic.

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  WebhookRateLimiter,
  deleteChunk,
  deleteChunkBot,
  downloadChunk,
  downloadChunkBot,
  parseWebhookUrls,
  uploadChunk,
  uploadChunkBot,
  type BotInfo,
  type WebhookInfo,
} from "@ddv4/discord-client";
import {
  TelegramRateLimiter,
  deleteMessage,
  downloadDocument,
  uploadDocument,
  type TgBotInfo,
} from "@ddv4/telegram-client";
import { serverConfig } from "@ddv4/config/server";
import type {
  BlobProviderPool,
  PlacementRef,
  PlacementWriteResult,
  PoolRole,
  ProviderKind,
} from "./provider.js";

const TG_STORAGE_PATH_PREFIX = "telegram://file/";

async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// LOCAL replica — separate directory tree (DDV4_REPLICA_BLOB_ROOT_DIR).
// Mostly useful for tests and belt-and-braces local copies.
// ---------------------------------------------------------------------------

function replicaBlobRootDir(): string {
  const configured = process.env.DDV4_REPLICA_BLOB_ROOT_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "var", "replica-blobs");
}

class LocalReplicaPool implements BlobProviderPool {
  readonly kind = "LOCAL" as const;
  readonly role: PoolRole = "REPLICA";

  async put(ownerUserId: string, blobId: string, bytes: Uint8Array): Promise<PlacementWriteResult> {
    const dir = path.join(replicaBlobRootDir(), ownerUserId.replace(/[\\/\0]/g, "_"));
    await mkdir(dir, { recursive: true });
    const storagePath = path.join(dir, `${blobId.replace(/[\\/\0]/g, "_")}.bin`);
    await writeFile(storagePath, bytes);
    return { provider: this.kind, storagePath, messageId: null, locationId: null, senderId: null };
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    const data = await readFile(placement.storagePath);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    try {
      const s = await stat(placement.storagePath);
      return { exists: true, size: s.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async delete(placement: PlacementRef): Promise<void> {
    await unlink(placement.storagePath);
  }

  senderCount(): number {
    return 1;
  }

  availability(): number {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// DISCORD replica — REPLICA_WEBHOOK_n + REPLICA_BOT_n senders
// ---------------------------------------------------------------------------

class DiscordReplicaPool implements BlobProviderPool {
  readonly kind = "DISCORD" as const;
  readonly role: PoolRole = "REPLICA";
  private limiter = new WebhookRateLimiter();
  private roundRobin = 0;
  private webhooks: WebhookInfo[];
  private bots: BotInfo[];

  constructor() {
    this.webhooks = parseWebhookUrls(serverConfig.replicaWebhooks);
    this.bots = serverConfig.replicaBotConfigs;
  }

  private senders(): Array<{ kind: "webhook"; info: WebhookInfo } | { kind: "bot"; info: BotInfo }> {
    return [
      ...this.webhooks.map((info) => ({ kind: "webhook" as const, info })),
      ...this.bots.map((info) => ({ kind: "bot" as const, info })),
    ];
  }

  private async selectSender() {
    const senders = this.senders();
    if (senders.length === 0) {
      throw new Error("Discord replica pool has no configured senders (REPLICA_WEBHOOK_n / REPLICA_BOT_n)");
    }
    while (true) {
      for (let i = 0; i < senders.length; i++) {
        const idx = (this.roundRobin + i) % senders.length;
        const sender = senders[idx]!;
        if (this.limiter.canUse(sender.info.id)) {
          this.roundRobin = (idx + 1) % senders.length;
          return sender;
        }
      }
      const nextReset = this.limiter.getNextResetMs(senders.map((s) => s.info.id));
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(nextReset || 50, 2000))));
    }
  }

  async put(ownerUserId: string, blobId: string, bytes: Uint8Array): Promise<PlacementWriteResult> {
    const sender = await this.selectSender();
    const filename = `${ownerUserId}-${blobId}.bin`;
    const data = bytes.slice().buffer;

    if (sender.kind === "webhook") {
      const upload = await uploadChunk(sender.info, data, filename, this.limiter, {});
      return {
        provider: this.kind,
        storagePath: `discord://attachments/${blobId}`,
        messageId: upload.messageId,
        locationId: upload.channelId,
        senderId: sender.info.id,
      };
    }

    const upload = await uploadChunkBot(sender.info, data, filename, this.limiter);
    return {
      provider: this.kind,
      storagePath: `discord://attachments/${blobId}`,
      messageId: upload.messageId,
      locationId: upload.channelId,
      senderId: sender.info.id,
    };
  }

  private webhookById(senderId: string): WebhookInfo {
    const webhook = this.webhooks.find((w) => w.id === senderId);
    if (!webhook) throw new Error(`Discord replica webhook ${senderId} is not configured`);
    return webhook;
  }

  private botById(senderId: string): BotInfo {
    const bot = this.bots.find((b) => b.id === senderId);
    if (!bot) throw new Error(`Discord replica bot ${senderId} is not configured`);
    return bot;
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    if (!placement.messageId || !placement.senderId) {
      throw new Error(`Discord replica blob ${placement.blobId} is missing transport coordinates`);
    }
    if (placement.senderId.startsWith("RBOT_")) {
      const bot = this.botById(placement.senderId);
      const stream = await downloadChunkBot(
        bot,
        placement.messageId,
        placement.locationId ?? bot.channelId,
        this.limiter,
      );
      return streamToUint8Array(stream);
    }
    const stream = await downloadChunk(this.webhookById(placement.senderId), placement.messageId, this.limiter);
    return streamToUint8Array(stream);
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    return { exists: placement.storagePath.startsWith("discord://attachments/"), size: 0 };
  }

  async delete(placement: PlacementRef): Promise<void> {
    if (!placement.messageId || !placement.senderId) return;
    if (placement.senderId.startsWith("RBOT_")) {
      const bot = this.botById(placement.senderId);
      await deleteChunkBot(bot, placement.messageId, placement.locationId ?? bot.channelId, this.limiter);
      return;
    }
    await deleteChunk(this.webhookById(placement.senderId), placement.messageId, this.limiter);
  }

  senderCount(): number {
    return this.senders().length;
  }

  availability(): number {
    return this.senders().filter((s) => this.limiter.canUse(s.info.id)).length;
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM replica — REPLICA_TG_BOT_n senders
// ---------------------------------------------------------------------------

class TelegramReplicaPool implements BlobProviderPool {
  readonly kind = "TELEGRAM" as const;
  readonly role: PoolRole = "REPLICA";
  private limiter = new TelegramRateLimiter();
  private roundRobin = 0;
  private bots: TgBotInfo[];

  constructor() {
    this.bots = serverConfig.replicaTelegramBotConfigs;
  }

  private async selectSender(): Promise<TgBotInfo> {
    if (this.bots.length === 0) {
      throw new Error("Telegram replica pool has no configured senders (REPLICA_TG_BOT_n)");
    }
    while (true) {
      for (let i = 0; i < this.bots.length; i++) {
        const idx = (this.roundRobin + i) % this.bots.length;
        const bot = this.bots[idx]!;
        if (this.limiter.canUse(bot.id)) {
          this.roundRobin = (idx + 1) % this.bots.length;
          return bot;
        }
      }
      const nextReset = this.limiter.getNextResetMs(this.bots.map((b) => b.id));
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(nextReset, 1000))));
    }
  }

  private botById(senderId: string): TgBotInfo {
    const bot = this.bots.find((b) => b.id === senderId);
    if (!bot) throw new Error(`Telegram replica sender ${senderId} is not configured`);
    return bot;
  }

  async put(ownerUserId: string, blobId: string, bytes: Uint8Array): Promise<PlacementWriteResult> {
    const bot = await this.selectSender();
    const upload = await uploadDocument(
      bot,
      bytes.slice().buffer,
      `${ownerUserId}-${blobId}.bin`,
      this.limiter,
    );
    return {
      provider: this.kind,
      storagePath: `${TG_STORAGE_PATH_PREFIX}${upload.fileId}`,
      messageId: upload.messageId,
      locationId: upload.chatId,
      senderId: bot.id,
    };
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    if (!placement.senderId) {
      throw new Error(`Telegram replica blob ${placement.blobId} is missing transport coordinates`);
    }
    if (!placement.storagePath.startsWith(TG_STORAGE_PATH_PREFIX)) {
      throw new Error(`Unsupported Telegram storage path: ${placement.storagePath}`);
    }
    const fileId = placement.storagePath.slice(TG_STORAGE_PATH_PREFIX.length);
    const stream = await downloadDocument(this.botById(placement.senderId), fileId, this.limiter);
    return streamToUint8Array(stream);
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    return { exists: placement.storagePath.startsWith(TG_STORAGE_PATH_PREFIX), size: 0 };
  }

  async delete(placement: PlacementRef): Promise<void> {
    if (!placement.messageId || !placement.senderId) return;
    const bot = this.botById(placement.senderId);
    await deleteMessage(bot, placement.locationId ?? bot.chatId, placement.messageId, this.limiter);
  }

  senderCount(): number {
    return this.bots.length;
  }

  availability(): number {
    return this.bots.filter((b) => this.limiter.canUse(b.id)).length;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let replicaPools: Map<ProviderKind, BlobProviderPool> | null = null;

function pools(): Map<ProviderKind, BlobProviderPool> {
  if (!replicaPools) {
    replicaPools = new Map<ProviderKind, BlobProviderPool>([
      ["LOCAL", new LocalReplicaPool()],
      ["DISCORD", new DiscordReplicaPool()],
      ["TELEGRAM", new TelegramReplicaPool()],
    ]);
  }
  return replicaPools;
}

export function getReplicaPool(kind: string): BlobProviderPool {
  const pool = pools().get(kind as ProviderKind);
  if (!pool) throw new Error(`Unsupported replica storage kind: ${kind}`);
  return pool;
}

/**
 * Replica providers this instance replicates to: STORAGE_REPLICA_PROVIDERS
 * (comma list) filtered down to pools that actually have senders configured.
 * Empty result = replication disabled.
 */
export function getConfiguredReplicaKinds(): ProviderKind[] {
  const list = process.env.STORAGE_REPLICA_PROVIDERS?.trim();
  if (!list) return [];
  return list
    .split(",")
    .map((entry) => {
      const kind = entry.trim().toUpperCase() as ProviderKind;
      if (!pools().has(kind)) {
        throw new Error(`Unsupported storage provider in STORAGE_REPLICA_PROVIDERS: ${entry.trim()}`);
      }
      return kind;
    })
    .filter((kind) => getReplicaPool(kind).senderCount() > 0);
}

/** Test/config-reload hook: forget cached pools so new env/serverConfig is picked up. */
export function clearReplicaPools(): void {
  replicaPools = null;
}
