// DiscorDrive v4 — Discord webhook chunk uploader

import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import type { WebhookRateLimiter } from "./rate-limiter.js";

export interface UploadResult {
  messageId: string;
  channelId: string;
  transportPath: "direct" | "relay" | "bot";
  attemptCount: number;
  upstreamStatus: number;
  elapsedMs: number;
  relayEgress: string | null;
}

export interface UploadChunkOptions {
  relayBaseUrl?: string;
  telemetry?: {
    requestId?: string;
    blobId?: string;
    uploadId?: string | null;
    chunkIndex?: string | null;
    chunkCount?: string | null;
  };
}

const MAX_RETRIES = 3;

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
  // Mutable: a network-dead relay degrades to a direct webhook upload — the
  // relay is an egress optimization, never a functional requirement.
  let relayBaseUrl = normalizeRelayBaseUrl(options?.relayBaseUrl);
  const webhookApiUrl = getWebhookApiUrl(webhook);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const url = relayBaseUrl ? `${relayBaseUrl}/upload` : `${webhookApiUrl}?wait=true`;
    const attemptStartMs = performance.now();
    rateLimiter.reserve(webhook.id);
    let response: Response;
    try {
      if (relayBaseUrl) {
        response = await fetch(url, {
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

        response = await fetch(url, {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(60_000),
        });
      }
    } catch (err: unknown) {
      rateLimiter.release(webhook.id);
      // Relay unreachable (down, refused, DNS) — fall back to uploading
      // directly to the webhook and keep going.
      if (relayBaseUrl) {
        console.warn(`[discord-client] relay unreachable for webhook ${webhook.id} (${describeFetchError(err)}) — falling back to direct upload`);
        relayBaseUrl = null;
        continue;
      }
      // Direct-path network failures (timeout, ECONNRESET, DNS) are retryable
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Upload failed for ${filename} after ${MAX_RETRIES} retries: ${describeFetchError(err)}`);
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
        transportPath: relayBaseUrl ? "relay" : "direct",
        attemptCount: attempt + 1,
        upstreamStatus: response.status,
        elapsedMs: Number((performance.now() - attemptStartMs).toFixed(2)),
        relayEgress: response.headers.get("x-relay-egress"),
      };
    }

    // Rate limited — wait and retry
    if (response.status === 429) {
      rateLimiter.recordError(429);
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
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
        const backoff = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
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
