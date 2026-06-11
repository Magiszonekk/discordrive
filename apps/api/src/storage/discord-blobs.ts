// DiscorDrive v4 — Discord blob transport adapter (secure files v2)

import {
  WebhookRateLimiter,
  downloadChunk,
  parseWebhookUrls,
  uploadChunk,
  type BotInfo,
  uploadChunkBot,
  downloadChunkBot,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";

const sharedRateLimiter = new WebhookRateLimiter();
let cachedWebhooks: ReturnType<typeof parseWebhookUrls> | null = null;
let cachedBots: BotInfo[] | null = null;
let sharedServerRoundRobinIndex = 0;
let sharedUserGroupRoundRobinIndex = 0;
let sharedBotRoundRobinIndex = 0;

// Per-sender concurrency limiter — separate from the rate limiter.
// Caps how many simultaneous uploads are dispatched to a single sender so load
// spreads across senders before falling back to slower tiers (relay webhooks).
const senderActiveUploads = new Map<string, number>();
const MAX_CONCURRENT_PER_SENDER = 2;

function senderHasCapacity(id: string): boolean {
  return (senderActiveUploads.get(id) ?? 0) < MAX_CONCURRENT_PER_SENDER;
}

function claimSender(id: string): void {
  senderActiveUploads.set(id, (senderActiveUploads.get(id) ?? 0) + 1);
}

function unclaimSender(id: string): void {
  const n = senderActiveUploads.get(id) ?? 1;
  if (n <= 1) senderActiveUploads.delete(id);
  else senderActiveUploads.set(id, n - 1);
}

export interface DiscordBlobUploadResult {
  storagePath: string;
  discordMessageId: string;
  discordChannelId: string;
  webhookId: string;
  ciphertext: Uint8Array;
  transportPath: "direct" | "relay" | "bot";
  attemptCount: number;
  upstreamStatus: number;
  elapsedMs: number;
  relayEgress: string | null;
  limiterRemaining: number;
  limiterInFlight: number;
}

function normalizeBytes(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function getConfiguredWebhooks() {
  if (!cachedWebhooks) {
    cachedWebhooks = parseWebhookUrls(serverConfig.webhooks);
  }
  if (!cachedWebhooks.length) {
    throw new Error("Discord blob transport requires at least one configured webhook");
  }
  return cachedWebhooks;
}

function getConfiguredBots(): BotInfo[] {
  if (!cachedBots) {
    // Bots require READ_MESSAGE_HISTORY to serve downloads.
    // Disable until that permission is granted in their channels.
    const enabled = process.env.BOT_UPLOADS_ENABLED === "1";
    cachedBots = enabled ? serverConfig.botConfigs : [];
    if (cachedBots.length > 0) {
      console.log(`[discord-blobs] ${cachedBots.length} bot sender(s) active`);
    }
  }
  return cachedBots;
}

function selectWebhookById<T extends { id: string }>(webhooks: T[], webhookId: string): T {
  const webhook = webhooks.find((candidate) => candidate.id === webhookId);
  if (!webhook) {
    throw new Error(`Discord webhook ${webhookId} is not configured`);
  }
  return webhook;
}

function shouldUseRelayForWebhook(webhookId: string): boolean {
  return !!serverConfig.relayBaseUrl && serverConfig.relayWebhookIds.includes(webhookId);
}

function getPositiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function getServerCount(webhookCount: number): number {
  return Math.max(1, Math.min(getPositiveIntFromEnv("SERVERS_COUNT", 1), Math.max(1, webhookCount)));
}

function getUserGroupCount(webhookCount: number): number {
  return Math.max(1, Math.min(getPositiveIntFromEnv("USER_GROUPS_COUNT", 1), Math.max(1, webhookCount)));
}

function partitionSequential<T>(items: T[], groupCount: number): T[][] {
  const safeGroupCount = Math.max(1, Math.min(groupCount, items.length || 1));
  const groups: T[][] = [];
  const baseSize = Math.floor(items.length / safeGroupCount);
  const remainder = items.length % safeGroupCount;
  let offset = 0;

  for (let i = 0; i < safeGroupCount; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    groups.push(items.slice(offset, offset + size));
    offset += size;
  }

  return groups.filter((group) => group.length > 0);
}

type GroupedWebhook<T extends { id: string }> = {
  webhook: T;
  userGroupIndex: number;
  serverGroupIndex: number;
  indexWithinServerGroup: number;
};

function buildGroupedWebhooks<T extends { id: string }>(webhooks: T[]): GroupedWebhook<T>[] {
  const userGroups = partitionSequential(webhooks, getUserGroupCount(webhooks.length));
  const totalServers = getServerCount(webhooks.length);
  const grouped: GroupedWebhook<T>[] = [];

  userGroups.forEach((userGroup, userGroupIndex) => {
    const proportionalServerCount = Math.max(
      1,
      Math.round((totalServers * userGroup.length) / Math.max(1, webhooks.length)),
    );
    const serverGroups = partitionSequential(userGroup, proportionalServerCount);
    serverGroups.forEach((serverGroup, serverGroupIndex) => {
      serverGroup.forEach((webhook, indexWithinServerGroup) => {
        grouped.push({ webhook, userGroupIndex, serverGroupIndex, indexWithinServerGroup });
      });
    });
  });

  return grouped;
}

function scoreGroupedWebhook<T extends { id: string }>(candidate: GroupedWebhook<T>): number {
  const userGroupsCount = Math.max(1, getUserGroupCount(10_000));
  const userDistance = (candidate.userGroupIndex - sharedUserGroupRoundRobinIndex + userGroupsCount) % userGroupsCount;
  const serverDistance = (candidate.serverGroupIndex - sharedServerRoundRobinIndex + 32) % 32;
  return userDistance * 10_000 + serverDistance * 100 + candidate.indexWithinServerGroup;
}

function advanceGroupCursors<T extends { id: string }>(selected: GroupedWebhook<T>, groupedWebhooks: GroupedWebhook<T>[]): void {
  const userGroupsCount = Math.max(1, groupedWebhooks.reduce((max, item) => Math.max(max, item.userGroupIndex + 1), 0));
  const serverGroupsInUser = groupedWebhooks.filter((item) => item.userGroupIndex === selected.userGroupIndex)
    .reduce((max, item) => Math.max(max, item.serverGroupIndex + 1), 0);

  sharedUserGroupRoundRobinIndex = userGroupsCount > 0
    ? (selected.userGroupIndex + 1) % userGroupsCount
    : 0;
  sharedServerRoundRobinIndex = serverGroupsInUser > 0
    ? (selected.serverGroupIndex + 1) % serverGroupsInUser
    : 0;
}

// Returns a webhook OR a bot. Selection is tiered by latency:
//   Tier 1 — direct webhooks (group-aware round-robin, fast)
//   Tier 2 — bots (simple round-robin, fast, direct to Discord API)
//   Tier 3 — relay webhooks (group-aware round-robin, slower — egress via relay)
//   Tier 4 — waitForAvailable across all senders (all rate-limited)
// This ensures relay webhooks are only used when both direct webhooks and bots
// are saturated, reducing per-upload variance from relay latency.
type SelectedSender =
  | { kind: "webhook"; info: ReturnType<typeof parseWebhookUrls>[number] }
  | { kind: "bot"; info: BotInfo };

async function selectSender(
  webhooks: ReturnType<typeof parseWebhookUrls>,
  bots: BotInfo[],
): Promise<SelectedSender> {
  const groupedWebhooks = buildGroupedWebhooks(webhooks);
  if (groupedWebhooks.length === 0) {
    throw new Error("No Discord webhooks configured");
  }

  const directGrouped = groupedWebhooks.filter((g) => !shouldUseRelayForWebhook(g.webhook.id));
  const relayGrouped = groupedWebhooks.filter((g) => shouldUseRelayForWebhook(g.webhook.id));
  const allIds = [...webhooks.map((w) => w.id), ...bots.map((b) => b.id)];

  // Poll until a sender slot is available. Two conditions can block:
  //   a) rate-limited (Discord 429 window not yet reset)
  //   b) at per-sender concurrency cap (MAX_CONCURRENT_PER_SENDER active uploads)
  // waitForAvailable handles (a); the 100ms sleep handles (b).
  while (true) {
    // Tier 1: direct webhooks (group-aware round-robin, fast)
    const availableDirect = directGrouped
      .filter((c) => sharedRateLimiter.canUse(c.webhook.id) && senderHasCapacity(c.webhook.id))
      .sort((a, b) => scoreGroupedWebhook(a) - scoreGroupedWebhook(b));

    if (availableDirect.length > 0) {
      const selected = availableDirect[0]!;
      advanceGroupCursors(selected, groupedWebhooks);
      claimSender(selected.webhook.id);
      return { kind: "webhook", info: selected.webhook };
    }

    // Tier 2: bots (simple round-robin, fast)
    if (bots.length > 0) {
      for (let i = 0; i < bots.length; i++) {
        const idx = (sharedBotRoundRobinIndex + i) % bots.length;
        const bot = bots[idx]!;
        if (sharedRateLimiter.canUse(bot.id) && senderHasCapacity(bot.id)) {
          sharedBotRoundRobinIndex = (idx + 1) % bots.length;
          claimSender(bot.id);
          return { kind: "bot", info: bot };
        }
      }
    }

    // Tier 3: relay webhooks (group-aware round-robin, slower)
    const availableRelay = relayGrouped
      .filter((c) => sharedRateLimiter.canUse(c.webhook.id) && senderHasCapacity(c.webhook.id))
      .sort((a, b) => scoreGroupedWebhook(a) - scoreGroupedWebhook(b));

    if (availableRelay.length > 0) {
      const selected = availableRelay[0]!;
      advanceGroupCursors(selected, groupedWebhooks);
      claimSender(selected.webhook.id);
      return { kind: "webhook", info: selected.webhook };
    }

    // All senders at capacity or rate-limited: wait for whichever unblocks first.
    // getNextResetMs covers the rate-limit case; 100ms cap covers the capacity case.
    const nextReset = sharedRateLimiter.getNextResetMs(allIds);
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(nextReset, 100))));
  }
}

async function streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

export async function uploadCiphertextBlobToDiscord(
  ownerUserId: string,
  blobId: string,
  bytes: ArrayBuffer | ArrayBufferView,
  telemetry?: {
    requestId?: string;
    uploadId?: string | null;
    chunkIndex?: string | null;
    chunkCount?: string | null;
  },
): Promise<DiscordBlobUploadResult> {
  const ciphertext = normalizeBytes(bytes);
  const webhooks = getConfiguredWebhooks();
  const bots = getConfiguredBots();
  const sender = await selectSender(webhooks, bots);
  const filename = `${ownerUserId}-${blobId}.bin`;

  if (sender.kind === "webhook") {
    const webhook = sender.info;
    try {
      const upload = await uploadChunk(
        webhook,
        ciphertext.slice().buffer,
        filename,
        sharedRateLimiter,
        {
          ...(shouldUseRelayForWebhook(webhook.id)
            ? { relayBaseUrl: serverConfig.relayBaseUrl }
            : {}),
          telemetry: {
            requestId: telemetry?.requestId,
            blobId,
            uploadId: telemetry?.uploadId,
            chunkIndex: telemetry?.chunkIndex,
            chunkCount: telemetry?.chunkCount,
          },
        },
      );
      const limiterSnapshot = sharedRateLimiter.getStateSnapshot(webhook.id);
      return {
        storagePath: `discord://attachments/${blobId}`,
        discordMessageId: upload.messageId,
        discordChannelId: upload.channelId,
        webhookId: webhook.id,
        ciphertext,
        transportPath: upload.transportPath,
        attemptCount: upload.attemptCount,
        upstreamStatus: upload.upstreamStatus,
        elapsedMs: upload.elapsedMs,
        relayEgress: upload.relayEgress,
        limiterRemaining: limiterSnapshot.remaining,
        limiterInFlight: limiterSnapshot.inFlight,
      };
    } finally {
      unclaimSender(webhook.id);
    }
  } else {
    const bot = sender.info;
    try {
      const upload = await uploadChunkBot(bot, ciphertext.slice().buffer, filename, sharedRateLimiter);
      const limiterSnapshot = sharedRateLimiter.getStateSnapshot(bot.id);
      return {
        storagePath: `discord://attachments/${blobId}`,
        discordMessageId: upload.messageId,
        discordChannelId: upload.channelId,
        // webhookId column stores sender ID — "BOT_n" distinguishes bots from webhook numeric IDs
        webhookId: bot.id,
        ciphertext,
        transportPath: "bot",
        attemptCount: upload.attemptCount,
        upstreamStatus: upload.upstreamStatus,
        elapsedMs: upload.elapsedMs,
        relayEgress: null,
        limiterRemaining: limiterSnapshot.remaining,
        limiterInFlight: limiterSnapshot.inFlight,
      };
    } finally {
      unclaimSender(bot.id);
    }
  }
}

export async function fetchCiphertextBlobFromDiscord(
  storagePath: string,
  discordMessageId: string,
  webhookId: string,
  discordChannelId?: string | null,
): Promise<Uint8Array> {
  if (!storagePath.startsWith("discord://attachments/")) {
    throw new Error(`Unsupported Discord storage path: ${storagePath}`);
  }

  // Bot-uploaded chunks use "BOT_n" as webhookId
  if (webhookId.startsWith("BOT_")) {
    const bots = getConfiguredBots();
    const bot = bots.find((b) => b.id === webhookId);
    if (!bot) {
      throw new Error(`Bot sender ${webhookId} is not configured`);
    }
    const channelId = discordChannelId ?? bot.channelId;
    const stream = await downloadChunkBot(bot, discordMessageId, channelId, sharedRateLimiter);
    return streamToUint8Array(stream);
  }

  const webhooks = getConfiguredWebhooks();
  const webhook = selectWebhookById(webhooks, webhookId);
  const stream = await downloadChunk(webhook, discordMessageId, sharedRateLimiter);
  return streamToUint8Array(stream);
}

export async function statDiscordBlob(storagePath: string): Promise<{ exists: boolean; size: number }> {
  return {
    exists: storagePath.startsWith("discord://attachments/"),
    size: 0,
  };
}

export function clearDiscordBlobStore(): void {
  // Reset module-level sender caches so tests (and config reloads) see the
  // current serverConfig instead of values cached at first use.
  cachedWebhooks = null;
  cachedBots = null;
}
