// DiscorDrive v4 — Server-only configuration (reads process.env)
// NEVER import this from browser/frontend code.

import type { AppMode } from "@ddv4/types";

/**
 * Collect webhook URLs from env vars: WEBHOOK_1, WEBHOOK_2, ...
 * Supports up to 50 webhooks.
 */
function collectWebhooks(): string[] {
  const webhooks: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const url = process.env[`WEBHOOK_${i}`];
    if (url?.trim()) {
      webhooks.push(url.trim());
    }
  }
  return webhooks;
}

/**
 * Collect bot configs from env vars: BOT_1 + BOT_1_CHANNEL, BOT_2 + BOT_2_CHANNEL, ...
 * Both token and channel must be set for a bot to be included.
 */
function collectBotConfigs(): Array<{ id: string; token: string; channelId: string }> {
  const configs: Array<{ id: string; token: string; channelId: string }> = [];
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`BOT_${i}`]?.trim();
    const channelId = process.env[`BOT_${i}_CHANNEL`]?.trim();
    if (token && channelId) {
      configs.push({ id: `BOT_${i}`, token, channelId });
    }
  }
  return configs;
}

/**
 * Collect Telegram bot configs from env vars: TG_BOT_1 + TG_BOT_1_CHAT, ...
 * One bot maps to one private channel/group (chat id like "-100..."); the bot
 * must be an admin there so it can delete its own messages on purge.
 */
function collectTelegramBotConfigs(): Array<{ id: string; token: string; chatId: string }> {
  const configs: Array<{ id: string; token: string; chatId: string }> = [];
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`TG_BOT_${i}`]?.trim();
    const chatId = process.env[`TG_BOT_${i}_CHAT`]?.trim();
    if (token && chatId) {
      configs.push({ id: `TG_BOT_${i}`, token, chatId });
    }
  }
  return configs;
}

// --- REPLICA sender pools -------------------------------------------------
// Physically separate senders (different channels/servers/accounts) reserved
// for replication traffic. They have their own rate-limit budgets, so copying
// never competes with primary uploads, and losing the primary Discord account
// does not touch the replica's. Sender IDs carry an R-prefix so a replica
// sender can never be picked by a primary pool (and vice versa).

function collectReplicaWebhooks(): string[] {
  const webhooks: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const url = process.env[`REPLICA_WEBHOOK_${i}`];
    if (url?.trim()) {
      webhooks.push(url.trim());
    }
  }
  return webhooks;
}

function collectReplicaBotConfigs(): Array<{ id: string; token: string; channelId: string }> {
  const configs: Array<{ id: string; token: string; channelId: string }> = [];
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`REPLICA_BOT_${i}`]?.trim();
    const channelId = process.env[`REPLICA_BOT_${i}_CHANNEL`]?.trim();
    if (token && channelId) {
      configs.push({ id: `RBOT_${i}`, token, channelId });
    }
  }
  return configs;
}

function collectReplicaTelegramBotConfigs(): Array<{ id: string; token: string; chatId: string }> {
  const configs: Array<{ id: string; token: string; chatId: string }> = [];
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`REPLICA_TG_BOT_${i}`]?.trim();
    const chatId = process.env[`REPLICA_TG_BOT_${i}_CHAT`]?.trim();
    if (token && chatId) {
      configs.push({ id: `R_TG_BOT_${i}`, token, chatId });
    }
  }
  return configs;
}

export const serverConfig = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  webhooks: collectWebhooks(),
  relayWebhookIds: (process.env.RELAY_WEBHOOK_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  relayBaseUrl: process.env.RELAY_BASE_URL?.trim() ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  appMode: (process.env.APP_MODE ?? "full") as AppMode,
  apiPort: parseInt(process.env.API_PORT ?? "3000", 10),
  frontendPort: parseInt(process.env.FRONTEND_PORT ?? "5173", 10),
  apiUrl: process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? "3000"}`,
  frontendUrl: process.env.FRONTEND_URL ?? `http://localhost:${process.env.FRONTEND_PORT ?? "5173"}`,
  apiKey: process.env.API_KEY ?? "",
  botConfigs: collectBotConfigs(),
  telegramBotConfigs: collectTelegramBotConfigs(),
  replicaWebhooks: collectReplicaWebhooks(),
  replicaBotConfigs: collectReplicaBotConfigs(),
  replicaTelegramBotConfigs: collectReplicaTelegramBotConfigs(),
};
