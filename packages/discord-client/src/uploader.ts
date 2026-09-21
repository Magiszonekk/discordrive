// DiscorDrive v4 — Discord webhook chunk uploader

import type { Dispatcher } from "undici";
import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import { DIRECT_EGRESS_KEY, type WebhookRateLimiter } from "./rate-limiter.js";
import {
  DiscordUnavailableError,
  isCloudflareBlock,
  retryAfterMsFrom,
} from "./downloader.js";

export interface UploadResult {
  messageId: string;
  channelId: string;
  transportPath: "direct" | "relay" | "proxy" | "bot";
  /** Exact egress path used: "direct" | "relay" | "proxy:<name>" | "bot". */
  egressKey: string;
  attemptCount: number;
  upstreamStatus: number;
  elapsedMs: number;
  relayEgress: string | null;
}

export interface UploadChunkOptions {
  /**
   * LEGACY: fixed-per-webhook-id throughput-relay experiment from June 2026
   * (see references/discord-per-ip-relay-experiment.md). Posts raw bytes to
   * `${relayBaseUrl}/upload` with discrete `x-relay-*` headers; the relay
   * server rebuilds the multipart form and posts to Discord itself. Kept
   * only for backward compatibility with any still-configured
   * RELAY_BASE_URL/RELAY_WEBHOOK_IDS deployment. New code should use
   * `dispatcher` (the round-robin egress pool) instead — it needs no
   * separate relay server, just a standard HTTP forward proxy.
   */
  relayBaseUrl?: string;
  /**
   * undici ProxyAgent (or any Dispatcher) routing this request through a
   * forward proxy on a different public IP. Absent = this host's own direct
   * egress. This is the mechanism behind the round-robin egress pool
   * (`egress-pool.ts`): the SAME webhook upload, same multipart body, same
   * Discord endpoint — only the outbound TCP connection's source IP differs.
   */
  dispatcher?: Dispatcher;
  /**
   * Rate-limiter bookkeeping key for THIS request's egress path. Defaults to
   * "direct" when neither relayBaseUrl nor dispatcher is set, "relay" when
   * relayBaseUrl is set, or must be passed explicitly (e.g. "proxy:oracle")
   * alongside a dispatcher. Must be unique per distinct outbound IP so a
   * Cloudflare block or proactive budget exhaustion on one path never blocks
   * a different, healthy path.
   */
  egressKey?: string;
  telemetry?: {
    requestId?: string;
    blobId?: string;
    uploadId?: string | null;
    chunkIndex?: string | null;
    chunkCount?: string | null;
  };
}

const MAX_RETRIES = 3;

/**
 * Cap on a single 429 sleep. See downloader.ts for the full rationale: a
 * Cloudflare IP block reports retry-after in the thousands of seconds, and
 * sleeping it out here held the sender's concurrency slot for tens of minutes,
 * which stalled the whole upload pool instead of failing over to bots.
 */
const MAX_RETRY_AFTER_MS = 60_000;

function normalizeRelayBaseUrl(relayBaseUrl?: string): string | null {
  const trimmed = relayBaseUrl?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

/** undici buries the real cause ("fetch failed" + cause: ECONNREFUSED) — surface it. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { message?: string; code?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

export async function uploadChunk(
  webhook: WebhookInfo,
  data: ArrayBuffer,
  filename: string,
  rateLimiter: WebhookRateLimiter,
  options?: UploadChunkOptions,
): Promise<UploadResult> {
  // Mutable: a network-dead legacy relay degrades to a direct webhook upload
  // (that relay is an opportunistic throughput optimization, never a
  // functional requirement). A dead PROXY dispatcher does NOT silently
  // degrade to direct — the caller chose that egress deliberately (as part
  // of the round-robin pool, possibly BECAUSE direct is Cloudflare-blocked),
  // so a proxy failure must surface as an error the caller can act on
  // (try the next egress in the pool) rather than quietly re-dialing a
  // route that might be exactly what is broken.
  let relayBaseUrl = normalizeRelayBaseUrl(options?.relayBaseUrl);
  const dispatcher = options?.dispatcher;
  const initialEgressKey =
    options?.egressKey ?? (dispatcher ? "proxy" : relayBaseUrl ? "relay" : DIRECT_EGRESS_KEY);
  let egressKey = initialEgressKey;
  const webhookApiUrl = getWebhookApiUrl(webhook);
  let lastError: Error | null = null;

  // Cannot succeed while Cloudflare is blocking THIS egress path. Throw
  // immediately so the caller can pick a different egress from the pool
  // instead of burning retries (and extending the block) on a route that is
  // down.
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
    const attemptStartMs = performance.now();

    // Proactive throttle: once this egress path is more than half through its
    // rolling request budget, add a small base+jitter delay BEFORE sending,
    // so the request rate tapers off ahead of Cloudflare's own ban threshold
    // instead of only reacting after a 429 arrives.
    const backoff = rateLimiter.getProactiveBackoffMs(egressKey);
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    rateLimiter.recordEgressRequest(egressKey);

    rateLimiter.reserve(webhook.id);
    let response: Response;
    try {
      if (relayBaseUrl) {
        response = await fetch(`${relayBaseUrl}/upload`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-discord-webhook-url": webhookApiUrl,
            "x-discord-filename": filename,
            "x-relay-request-id": options?.telemetry?.requestId ?? "",
            "x-relay-blob-id": options?.telemetry?.blobId ?? "",
            "x-relay-upload-id": options?.telemetry?.uploadId ?? "",
            "x-relay-chunk-index": options?.telemetry?.chunkIndex ?? "",
            "x-relay-chunk-count": options?.telemetry?.chunkCount ?? "",
            "x-relay-webhook-id": webhook.id,
          },
          body: data,
          signal: AbortSignal.timeout(60_000),
        });
      } else {
        const formData = new FormData();
        formData.append(
          "file",
          new Blob([data], { type: "application/octet-stream" }),
          filename,
        );

        const init: RequestInit & { dispatcher?: Dispatcher } = {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(60_000),
        };
        if (dispatcher) init.dispatcher = dispatcher;
        response = await fetch(`${webhookApiUrl}?wait=true`, init);
      }
    } catch (err: unknown) {
      rateLimiter.release(webhook.id);
      // Legacy relay unreachable (down, refused, DNS): only degrade to
      // direct when the caller did not explicitly ask for this egress
      // because direct is blocked (i.e. the ORIGINAL egressKey was already
      // "direct" with an opportunistic relayBaseUrl). A dispatcher-based
      // proxy failure never degrades — see the comment above initialEgressKey.
      if (relayBaseUrl && initialEgressKey === DIRECT_EGRESS_KEY) {
        console.warn(`[discord-client] relay unreachable for webhook ${webhook.id} (${describeFetchError(err)}) — falling back to direct upload`);
        relayBaseUrl = null;
        egressKey = DIRECT_EGRESS_KEY;
        continue;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Upload failed for ${filename} after ${MAX_RETRIES} retries via egress '${egressKey}': ${describeFetchError(err)}`);
    }

    rateLimiter.release(webhook.id);
    rateLimiter.recordResponse(webhook.id, response.headers);

    if (response.ok) {
      const json = (await response.json()) as {
        id: string;
        channel_id: string;
      };
      return {
        messageId: json.id,
        channelId: json.channel_id,
        transportPath: dispatcher ? "proxy" : relayBaseUrl ? "relay" : "direct",
        egressKey,
        attemptCount: attempt + 1,
        upstreamStatus: response.status,
        elapsedMs: Number((performance.now() - attemptStartMs).toFixed(2)),
        relayEgress: response.headers.get("x-relay-egress"),
      };
    }

    // Rate limited — wait and retry
    if (response.status === 429) {
      rateLimiter.recordError(429);
      const cfBlocked = isCloudflareBlock(response);
      const waitMs = retryAfterMsFrom(response);
      rateLimiter.recordThrottle(webhook.id, waitMs, cfBlocked, egressKey);

      // Never hold the sender slot through a multi-minute block: fail fast so
      // the caller can pick a different egress from the pool, which uses a
      // different IP that Cloudflare is not blocking.
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

    // Chunk too large — signal to caller
    if (response.status === 413) {
      throw new Error(`CHUNK_TOO_LARGE: Discord rejected file as too large`);
    }

    // Auth errors
    if (response.status === 401 || response.status === 403) {
      rateLimiter.recordError(response.status);
      throw new Error(
        `AUTH_ERROR: Discord returned ${response.status} for webhook ${webhook.id}`,
      );
    }

    // Server errors — retry with exponential backoff
    if (response.status >= 500) {
      lastError = new Error(
        `Discord server error: ${response.status} ${response.statusText}`,
      );
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
    }

    // Other errors — don't retry
    const text = await response.text();
    throw new Error(
      `Discord upload failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  throw lastError ?? new Error("Upload failed after max retries");
}
