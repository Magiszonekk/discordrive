// DiscorDrive v4 — Discord message/chunk deleter

import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import type { WebhookRateLimiter } from "./rate-limiter.js";

const MAX_RETRIES = 3;

export async function deleteChunk(
  webhook: WebhookInfo,
  messageId: string,
  rateLimiter: WebhookRateLimiter,
): Promise<void> {
  const url = `${getWebhookApiUrl(webhook)}/messages/${messageId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Delete timed out for message ${messageId} after ${MAX_RETRIES} retries`);
      }
      throw err;
    }
    rateLimiter.recordResponse(webhook.id, response.headers);

    if (response.ok || response.status === 204) {
      return;
    }

    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    // Already deleted — treat as success
    if (response.status === 404) {
      return;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const backoff = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    throw new Error(
      `Failed to delete message ${messageId}: ${response.status} ${response.statusText}`,
    );
  }

  throw new Error(`Failed to delete chunk after ${MAX_RETRIES} retries`);
}
