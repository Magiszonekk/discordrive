// DiscorDrive v4 — Discord chunk downloader (get fresh CDN URL + stream)

import type { Dispatcher } from "undici";
import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import { DIRECT_EGRESS_KEY, type WebhookRateLimiter } from "./rate-limiter.js";

const MAX_RETRIES = 3;

/**
 * Upper bound on how long we will sleep for a single 429 before giving up.
 *
 * Discord's own per-route limits report `retry-after` in seconds and are small.
 * A Cloudflare IP-level block on /api/v10/webhooks/ instead reports
 * `retry-after` in the THOUSANDS (2248s = 37 min observed on prod), and the old
 * code slept for exactly that, up to MAX_RETRIES times — roughly two hours
 * inside one request, with the sender slot held the whole time. Downloads
 * therefore never emitted response headers and the browser hung with no error.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Thrown when the retry-after is so long that waiting is pointless. */
export class DiscordUnavailableError extends Error {
  readonly retryAfterMs: number;
  readonly cloudflareBlocked: boolean;
  constructor(message: string, retryAfterMs: number, cloudflareBlocked: boolean) {
    super(message);
    this.name = "DiscordUnavailableError";
    this.retryAfterMs = retryAfterMs;
    this.cloudflareBlocked = cloudflareBlocked;
  }
}

/**
 * A Cloudflare edge block is distinguishable from a real Discord rate limit:
 * Discord always returns JSON plus x-ratelimit-* headers. Cloudflare's block
 * page is NOT reliably text/html — verified live on prod 2026-09-10 AND
 * again 2026-09-14: `content-type: text/plain; charset=UTF-8`, body
 * "error code: 1015", `server: cloudflare`, no x-ratelimit-*. Do not key this
 * detection on a specific content-type substring (a sibling deployment's
 * downloader.ts had exactly that bug — checked for "text/html" and missed
 * the text/plain variant, meaning ITS Cloudflare-block detection silently
 * never fired). The reliable signal is the ABSENCE of Discord's own
 * x-ratelimit-* + JSON contract, not the presence of any particular
 * Cloudflare content-type.
 */
export function isCloudflareBlock(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    !contentType.includes("application/json") &&
    response.headers.get("x-ratelimit-remaining") === null
  );
}

export function retryAfterMsFrom(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 5_000;
  const seconds = parseFloat(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : 5_000;
}

interface DiscordAttachment {
  url: string;
  size: number;
  filename: string;
}

interface DiscordMessage {
  id: string;
  attachments: DiscordAttachment[];
}

export interface EgressRequestOptions {
  /** Rate-limiter bookkeeping key for this request's egress path. */
  egressKey?: string;
  /** undici dispatcher routing this request through a forward proxy; absent = this host's own direct egress. */
  dispatcher?: Dispatcher;
}

/**
 * Get fresh CDN URL by fetching the Discord message.
 * CDN URLs expire after ~24h, so we always fetch on-demand.
 *
 * `options.egressKey` identifies which network path this request goes out on
 * ("direct" for this host's own IP, or a proxy key like "proxy:oracle").
 * Cloudflare blocks and the proactive request budget are tracked per egress
 * path, so a ban on one path does not falsely block a different, healthy one.
 */
export async function getChunkUrl(
  webhook: WebhookInfo,
  messageId: string,
  rateLimiter: WebhookRateLimiter,
  options?: EgressRequestOptions,
): Promise<string> {
  const url = `${getWebhookApiUrl(webhook)}/messages/${messageId}`;
  const egressKey = options?.egressKey ?? DIRECT_EGRESS_KEY;

  // Don't dial an IP that Cloudflare is actively blocking: every attempt would
  // 429 anyway and each one refreshes the block's window, prolonging it.
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
      const init: RequestInit & { dispatcher?: Dispatcher } = { signal: AbortSignal.timeout(30_000) };
      if (options?.dispatcher) init.dispatcher = options.dispatcher;
      response = await fetch(url, init);
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
      const cfBlocked = isCloudflareBlock(response);
      const waitMs = retryAfterMsFrom(response);
      rateLimiter.recordThrottle(webhook.id, waitMs, cfBlocked, egressKey);

      // Fail fast instead of sleeping out the clock inside the request. A
      // Cloudflare block lasts tens of minutes; sleeping through it turns a
      // recoverable error into a hung connection with no response headers.
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

    if (response.status === 404) {
      throw new Error(`Message ${messageId} not found — chunk may be deleted`);
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
 * CDN is never proxied — it's a different host/route than the webhook API
 * and is not part of the Cloudflare webhook-route ban.
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

/**
 * Get fresh CDN URL and stream chunk data, with retry on transient CDN errors.
 * Re-fetches the CDN URL on each retry (URLs can expire or become stale).
 */
export async function downloadChunk(
  webhook: WebhookInfo,
  messageId: string,
  rateLimiter: WebhookRateLimiter,
  options?: EgressRequestOptions,
): Promise<ReadableStream<Uint8Array>> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const cdnUrl = await getChunkUrl(webhook, messageId, rateLimiter, options);

    let response: Response;
    try {
      response = await fetch(cdnUrl, { signal: AbortSignal.timeout(60_000) });
    } catch (err: unknown) {
      if (attempt >= MAX_RETRIES) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw err;
    }

    if (response.ok && response.body) return response.body;

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }

    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  throw new Error(`Failed to download chunk after ${MAX_RETRIES} retries`);
}
