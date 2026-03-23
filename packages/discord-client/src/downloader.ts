// DiscorDrive v4 — Discord chunk downloader (get fresh CDN URL + stream)

import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import type { WebhookRateLimiter } from "./rate-limiter.js";

const MAX_RETRIES = 3;

interface DiscordAttachment {
  url: string;
  size: number;
  filename: string;
}

interface DiscordMessage {
  id: string;
  attachments: DiscordAttachment[];
}

/**
 * Get fresh CDN URL by fetching the Discord message.
 * CDN URLs expire after ~24h, so we always fetch on-demand.
 */
export async function getChunkUrl(
  webhook: WebhookInfo,
  messageId: string,
  rateLimiter: WebhookRateLimiter,
): Promise<string> {
  const url = `${getWebhookApiUrl(webhook)}/messages/${messageId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`getChunkUrl timed out for message ${messageId} after ${MAX_RETRIES} retries`);
      }
      throw err;
    }
    rateLimiter.recordResponse(webhook.id, response.headers);

    if (response.ok) {
      const message = (await response.json()) as DiscordMessage;
      if (!message.attachments.length) {
        throw new Error(
          `No attachments found on message ${messageId}`,
        );
      }
      return message.attachments[0].url;
    }

    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (response.status === 404) {
      throw new Error(`Message ${messageId} not found — chunk may be deleted`);
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const backoff = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    throw new Error(
      `Failed to get message ${messageId}: ${response.status} ${response.statusText}`,
    );
  }

  throw new Error(`Failed to get chunk URL after ${MAX_RETRIES} retries`);
}

/**
 * Stream chunk data from Discord CDN.
 * CDN requests do NOT count against Discord rate limits.
 */
export async function streamChunk(
  cdnUrl: string,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(cdnUrl, { signal: AbortSignal.timeout(60_000) });

  if (!response.ok) {
    throw new Error(
      `CDN download failed: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error("CDN response has no body");
  }

  return response.body;
}
