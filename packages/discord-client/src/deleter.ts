// DiscorDrive v4 — Discord message/chunk deleter

import type { Dispatcher } from "undici";
import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import { DIRECT_EGRESS_KEY, type WebhookRateLimiter } from "./rate-limiter.js";
import {
  DiscordUnavailableError,
  isCloudflareBlock,
  retryAfterMsFrom,
  type EgressRequestOptions,
} from "./downloader.js";

const MAX_RETRIES = 3;

/** See downloader.ts — never sleep out a multi-minute Cloudflare block. */
const MAX_RETRY_AFTER_MS = 60_000;

export async function deleteChunk(
  webhook: WebhookInfo,
  messageId: string,
  rateLimiter: WebhookRateLimiter,
  options?: EgressRequestOptions,
): Promise<void> {
  const url = `${getWebhookApiUrl(webhook)}/messages/${messageId}`;
  const egressKey = options?.egressKey ?? DIRECT_EGRESS_KEY;

  // The trash sweep deletes thousands of chunks in a loop. Retrying each one
  // against a Cloudflare-blocked route both fails and keeps the block's window
  // refreshed, so bail out immediately and let the caller retry on a
  // different egress or a later sweep run.
  const blockedFor = rateLimiter.cloudflareBlockRemainingMs(egressKey);
  if (blockedFor > 0) {
    throw new DiscordUnavailableError(
      `Discord API is blocking egress '${egressKey}' (Cloudflare); retry in ~${Math.round(blockedFor / 1000)}s`,
      blockedFor,
      true,
    );
  }
  if (rateLimiter.isEgressOverBudget(egressKey)) {
    throw new DiscordUnavailableError(
      `Egress '${egressKey}' hit its proactive request budget; backing off before Cloudflare would`,
      5_000,
      false,
    );
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const backoff = rateLimiter.getProactiveBackoffMs(egressKey);
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    rateLimiter.recordEgressRequest(egressKey);

    let response: Response;
    try {
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      };
      if (options?.dispatcher) init.dispatcher = options.dispatcher;
      response = await fetch(url, init);
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
      const cfBlocked = isCloudflareBlock(response);
      const waitMs = retryAfterMsFrom(response);
      rateLimiter.recordThrottle(webhook.id, waitMs, cfBlocked, egressKey);

      if (cfBlocked || waitMs > MAX_RETRY_AFTER_MS) {
        throw new DiscordUnavailableError(
          cfBlocked
            ? `Discord API is blocking egress '${egressKey}' (Cloudflare); retry in ~${Math.round(waitMs / 1000)}s`
            : `Discord rate limit too long to wait out (${Math.round(waitMs / 1000)}s)`,
          waitMs,
          cfBlocked,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    // Already deleted — treat as success
    if (response.status === 404) {
      return;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    throw new Error(
      `Failed to delete message ${messageId}: ${response.status} ${response.statusText}`,
    );
  }

  throw new Error(`Failed to delete chunk after ${MAX_RETRIES} retries`);
}
