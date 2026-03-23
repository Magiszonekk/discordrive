// DiscorDrive v4 — Webhook parsing and management

export interface WebhookInfo {
  id: string;
  token: string;
  url: string;
}

const WEBHOOK_URL_REGEX = /\/webhooks\/(\d+)\/([A-Za-z0-9_-]+)\/?$/;

export function parseWebhookUrl(url: string): WebhookInfo {
  const match = url.trim().match(WEBHOOK_URL_REGEX);
  if (!match) {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  return {
    id: match[1],
    token: match[2],
    url: url.trim(),
  };
}

/**
 * Parse an array of webhook URLs into WebhookInfo objects.
 * Accepts the format from serverConfig.webhooks (collected from WEBHOOK_1, WEBHOOK_2, ...).
 */
export function parseWebhookUrls(urls: string[]): WebhookInfo[] {
  return urls.filter(Boolean).map(parseWebhookUrl);
}

export function getWebhookApiUrl(webhook: WebhookInfo): string {
  return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
}
