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
};
