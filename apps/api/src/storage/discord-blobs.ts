// DiscorDrive v4 — Discord blob transport adapter (secure files v2)

import {
  WebhookRateLimiter,
  downloadChunk,
  parseWebhookUrls,
  uploadChunk,
  type BotInfo,
  uploadChunkBot,
  downloadChunkBot,
  deleteChunk,
  deleteChunkBot,
  DiscordUnavailableError,
  DIRECT_EGRESS_KEY,
  buildEgressPool,
  EgressRoundRobin,
  type EgressDescriptor,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";

const sharedRateLimiter = new WebhookRateLimiter();
let cachedWebhooks: ReturnType<typeof parseWebhookUrls> | null = null;
let cachedBots: BotInfo[] | null = null;
let sharedServerRoundRobinIndex = 0;
let sharedUserGroupRoundRobinIndex = 0;
let sharedBotRoundRobinIndex = 0;
let cachedEgressPool: EgressDescriptor[] | null = null;
let sharedEgressRoundRobin: EgressRoundRobin | null = null;

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
  transportPath: "direct" | "relay" | "proxy" | "bot";
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

/**
 * Round-robin pool of egress paths this host's Discord traffic goes out on:
 * always this host's own direct IP (index 0) plus any configured `PROXY_<n>`
 * forward proxies. Unlike the old reactive tier design, EVERY request pulls
 * the next egress from the rotation — proxies carry real traffic in parallel
 * with direct, not only after a ban. `nextOrder()` returns the full pool
 * starting at the rotating cursor so a blocked/over-budget entry can be
 * skipped without stalling: the caller walks the order and uses the first
 * entry that is actually usable.
 */
function getEgressRoundRobin(): EgressRoundRobin {
  if (!sharedEgressRoundRobin || cachedEgressPool === null) {
    cachedEgressPool = buildEgressPool(serverConfig.proxies);
    sharedEgressRoundRobin = new EgressRoundRobin(cachedEgressPool);
    if (cachedEgressPool.length > 1) {
      console.log(`[discord-blobs] egress pool: ${cachedEgressPool.map((e) => e.name).join(", ")}`);
    }
  }
  return sharedEgressRoundRobin;
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

// Returns a webhook (with a chosen egress) OR a bot. Selection order:
//   1. Egress round-robin: pull the NEXT egress from the pool (direct or a
//      configured PROXY_<n>), rotating on every call — this is what makes
//      traffic genuinely fan out across direct+proxies in parallel rather
//      than only failing over to a proxy once direct is banned. Walk the
//      rotated order and use the first egress that is not Cloudflare-blocked
//      / over its proactive budget on that path, so one bad egress just gets
//      skipped this round instead of stalling every request.
//   2. Within the chosen egress, pick a direct webhook (group-aware
//      round-robin, same webhook pool used by every egress — a proxy just
//      changes which IP the SAME webhook request leaves from).
//   3. If NO egress in the whole pool has a usable webhook this round: bots
//      (different Discord API route entirely, immune to a webhook-route
//      ban on every egress at once).
//   4. Legacy fixed relay webhooks (RELAY_WEBHOOK_IDS), only as a last
//      resort — narrower than the general egress pool, kept for backward
//      compatibility with the June throughput experiment.
//   5. waitForAvailable across all senders (all rate-limited).
type SelectedSender =
  | { kind: "webhook"; info: ReturnType<typeof parseWebhookUrls>[number]; egress: EgressDescriptor }
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
  const egressRoundRobin = getEgressRoundRobin();
  const allIds = [...webhooks.map((w) => w.id), ...bots.map((b) => b.id)];

  // Poll until a sender slot is available. Two conditions can block:
  //   a) rate-limited (Discord 429 window not yet reset)
  //   b) at per-sender concurrency cap (MAX_CONCURRENT_PER_SENDER active uploads)
  // waitForAvailable handles (a); the 100ms sleep handles (b).
  while (true) {
    // Step 1+2: walk the egress rotation (starts at a different cursor
    // position EVERY call — that rotation is the round-robin), and within
    // each egress try the direct webhook pool.
    const egressOrder = egressRoundRobin.nextOrder();
    for (const egress of egressOrder) {
      const availableOnThisEgress = directGrouped
        .filter((c) => sharedRateLimiter.canUse(c.webhook.id, egress.key) && senderHasCapacity(c.webhook.id))
        .sort((a, b) => scoreGroupedWebhook(a) - scoreGroupedWebhook(b));

      if (availableOnThisEgress.length > 0) {
        const selected = availableOnThisEgress[0]!;
        advanceGroupCursors(selected, groupedWebhooks);
        claimSender(selected.webhook.id);
        return { kind: "webhook", info: selected.webhook, egress };
      }
    }

    // Step 3: bots (simple round-robin, fast) — reached only when EVERY
    // egress in the pool has no usable webhook this round.
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

    // Step 4: legacy relay webhooks (group-aware round-robin, slower)
    const availableRelay = relayGrouped
      .filter((c) => sharedRateLimiter.canUse(c.webhook.id) && senderHasCapacity(c.webhook.id))
      .sort((a, b) => scoreGroupedWebhook(a) - scoreGroupedWebhook(b));

    if (availableRelay.length > 0) {
      const selected = availableRelay[0]!;
      advanceGroupCursors(selected, groupedWebhooks);
      claimSender(selected.webhook.id);
      return { kind: "webhook", info: selected.webhook, egress: { key: "relay", name: "relay" } };
    }

    // All senders at capacity or rate-limited on every egress: wait for
    // whichever unblocks first. getNextResetMs covers the rate-limit case;
    // 100ms cap covers the capacity case. During a Cloudflare block on one
    // egress, getNextResetMs() reports THAT egress's multi-minute reset,
    // which must not translate into a multi-minute sleep here — the cap
    // keeps the loop responsive so a different egress/bot is picked up
    // as soon as one frees.
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
  const filename = `${ownerUserId}-${blobId}.bin`;

  // Retry across senders: a Cloudflare IP block takes out every webhook at
  // once, so the first pick can fail for a reason that has nothing to do with
  // this chunk. selectSender() consults the limiter, which now knows webhooks
  // are blocked, and returns a bot instead. Bounded so a genuine outage still
  // surfaces as an error rather than looping forever.
  const maxSenderAttempts = 3;
  let lastUnavailable: unknown = null;

  for (let senderAttempt = 0; senderAttempt < maxSenderAttempts; senderAttempt++) {
    const sender = await selectSender(webhooks, bots);

    try {
      return await uploadViaSender(sender, {
        ownerUserId,
        blobId,
        ciphertext,
        filename,
        telemetry,
      });
    } catch (error) {
      // Only a transport-level block is worth re-routing; real failures
      // (chunk too large, auth) must propagate untouched.
      if (!(error instanceof DiscordUnavailableError)) throw error;
      lastUnavailable = error;
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "blob-upload-debug",
        type: "sender_unavailable_failover",
        senderId: sender.kind === "webhook" ? sender.info.id : sender.info.id,
        senderKind: sender.kind,
        cloudflareBlocked: error.cloudflareBlocked,
        retryAfterMs: error.retryAfterMs,
        attempt: senderAttempt + 1,
      }));
    }
  }

  throw lastUnavailable ?? new Error("Discord upload failed: no sender available");
}

async function uploadViaSender(
  sender: SelectedSender,
  args: {
    ownerUserId: string;
    blobId: string;
    ciphertext: Uint8Array;
    filename: string;
    telemetry?: {
      requestId?: string;
      uploadId?: string | null;
      chunkIndex?: string | null;
      chunkCount?: string | null;
    };
  },
): Promise<DiscordBlobUploadResult> {
  const { blobId, ciphertext, filename, telemetry } = args;

  if (sender.kind === "webhook") {
    const webhook = sender.info;
    try {
      const isLegacyRelay = sender.egress.key === "relay";
      const upload = await uploadChunk(
        webhook,
        ciphertext.slice().buffer,
        filename,
        sharedRateLimiter,
        {
          ...(isLegacyRelay
            ? { relayBaseUrl: serverConfig.relayBaseUrl, egressKey: "relay" }
            : { dispatcher: sender.egress.dispatcher, egressKey: sender.egress.key }),
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
        relayEgress: isLegacyRelay ? upload.relayEgress : sender.egress.name,
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

  // A webhook-uploaded chunk is only reachable through the webhook route.
  // Unlike uploads, there is no bot fallback here (a bot outside the
  // channel's guild gets 403 on this message) — walking the SAME egress pool
  // used for uploads is the way to read this specific chunk back when one
  // egress is Cloudflare-blocked, so try each configured egress in turn
  // rather than surfacing an error the user cannot do anything about.
  const egressPool = getEgressRoundRobin().nextOrder();
  let lastError: unknown = null;
  for (const egress of egressPool) {
    try {
      const stream = await downloadChunk(webhook, discordMessageId, sharedRateLimiter, {
        egressKey: egress.key,
        dispatcher: egress.dispatcher,
      });
      if (egress.key !== DIRECT_EGRESS_KEY) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          scope: "blob-download-debug",
          type: "sender_unavailable_failover",
          senderId: webhookId,
          senderKind: "webhook",
          proxyName: egress.name,
          cloudflareBlocked: true,
        }));
      }
      return streamToUint8Array(stream);
    } catch (error) {
      lastError = error;
      // Only keep trying other egresses for a transport-level block; a real
      // failure (message deleted, chunk too large, etc.) must propagate.
      if (!(error instanceof DiscordUnavailableError)) throw error;
    }
  }
  throw lastError ?? new Error(`Download failed for message ${discordMessageId}: no egress available`);
}

/**
 * Test-only access to the process-shared limiter. Used to inject a Cloudflare
 * block and verify failover without stubbing the transport. Not part of the
 * runtime path.
 */
export function __getSharedRateLimiterForTests(): WebhookRateLimiter {
  return sharedRateLimiter;
}

/** Number of configured Discord senders (webhooks + enabled bots). */
export function discordSenderCount(): number {
  let count = 0;
  try {
    count += getConfiguredWebhooks().length;
  } catch {
    // no webhooks configured
  }
  count += getConfiguredBots().length;
  return count;
}

/** Senders currently usable (not rate-limited, below concurrency cap). */
export function discordSenderAvailability(): number {
  let senders: Array<{ id: string }> = [];
  try {
    senders = senders.concat(getConfiguredWebhooks());
  } catch {
    // no webhooks configured
  }
  senders = senders.concat(getConfiguredBots());
  return senders.filter((s) => sharedRateLimiter.canUse(s.id) && senderHasCapacity(s.id)).length;
}

export async function deleteCiphertextBlobFromDiscord(
  discordMessageId: string,
  webhookId: string,
  discordChannelId?: string | null,
): Promise<void> {
  if (webhookId.startsWith("BOT_")) {
    // Deletion must work even when bot uploads are disabled (BOT_UPLOADS_ENABLED
    // gates new uploads only), so look up the bot in raw config.
    const bot = serverConfig.botConfigs.find((b) => b.id === webhookId);
    if (!bot) {
      throw new Error(`Bot sender ${webhookId} is not configured`);
    }
    await deleteChunkBot(bot, discordMessageId, discordChannelId ?? bot.channelId, sharedRateLimiter);
    return;
  }

  const webhooks = getConfiguredWebhooks();
  const webhook = selectWebhookById(webhooks, webhookId);

  // Same rationale as fetchCiphertextBlobFromDiscord: a webhook-owned message
  // can only be deleted through the webhook route, and there is no bot
  // fallback. Without this, a trash-purge sweep running during a Cloudflare
  // block retries each delete, fails, and its own failed attempts refresh
  // the block's window — a self-sustaining feedback loop observed live on
  // the ddrive fork (288 blob_delete_failed in one hour while the ban was
  // active). Walking every egress in the pool breaks that loop instead of
  // feeding it.
  const egressPool = getEgressRoundRobin().nextOrder();
  let lastError: unknown = null;
  for (const egress of egressPool) {
    try {
      await deleteChunk(webhook, discordMessageId, sharedRateLimiter, {
        egressKey: egress.key,
        dispatcher: egress.dispatcher,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof DiscordUnavailableError)) throw error;
    }
  }
  throw lastError ?? new Error(`Delete failed for message ${discordMessageId}: no egress available`);
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
  cachedEgressPool = null;
  sharedEgressRoundRobin = null;
}
