// DiscorDrive v4 — Discord webhook chunk uploader

import { type WebhookInfo, getWebhookApiUrl } from "./webhooks.js";
import type { WebhookRateLimiter } from "./rate-limiter.js";

export interface UploadResult {
  messageId: string;
  channelId: string;
}

const MAX_RETRIES = 3;

export async function uploadChunk(
  webhook: WebhookInfo,
  data: ArrayBuffer,
  filename: string,
  rateLimiter: WebhookRateLimiter,
): Promise<UploadResult> {
  const url = `${getWebhookApiUrl(webhook)}?wait=true`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([data], { type: "application/octet-stream" }),
      filename,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error(`Upload timed out for ${filename} after ${MAX_RETRIES} retries`);
      }
      throw err;
    }

    rateLimiter.recordResponse(webhook.id, response.headers);

    if (response.ok) {
      const json = (await response.json()) as {
        id: string;
        channel_id: string;
      };
      return {
        messageId: json.id,
        channelId: json.channel_id,
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
