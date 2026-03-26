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

/**
 * Stream-through upload: pipes the incoming ReadableStream directly to Discord
 * while receiving it, so bodyRead and Discord upload overlap instead of running
 * sequentially. No 5xx retry — stream is consumed once; caller propagates the
 * error and the client retries the whole chunk.
 */
export async function uploadChunkStream(
  webhook: WebhookInfo,
  stream: ReadableStream<Uint8Array>,
  size: number,
  filename: string,
  rateLimiter: WebhookRateLimiter,
): Promise<UploadResult> {
  const url = `${getWebhookApiUrl(webhook)}?wait=true`;

  const boundary =
    "----DDV4Boundary" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const encoder = new TextEncoder();
  const partHeader = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `\r\n`,
  );
  const partFooter = encoder.encode(`\r\n--${boundary}--\r\n`);
  const totalSize = partHeader.byteLength + size + partFooter.byteLength;

  // Streaming multipart body: part-header → piped chunk data → part-footer
  // pull() is demand-driven: called only when undici fetch needs more data.
  // This creates true backpressure — no intermediate buffering of the 10MB body.
  let headerSent = false;
  const reader = stream.getReader();
  const multipartStream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(partHeader);
          return;
        }
        return reader.read().then(({ done, value }) => {
          if (done) {
            controller.enqueue(partFooter);
            controller.close();
          } else {
            controller.enqueue(value);
          }
        });
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 }, // pull only when consumer is ready — zero internal queuing
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      body: multipartStream,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": totalSize.toString(),
      },
      signal: AbortSignal.timeout(60_000),
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Upload timed out for ${filename}`);
    }
    throw err;
  }

  rateLimiter.recordResponse(webhook.id, response.headers);

  if (response.ok) {
    const json = (await response.json()) as { id: string; channel_id: string };
    return { messageId: json.id, channelId: json.channel_id };
  }

  if (response.status === 429) {
    rateLimiter.recordError(429);
    throw new Error(`RATE_LIMITED: Discord returned 429 during streaming upload`);
  }
  if (response.status === 413) {
    throw new Error(`CHUNK_TOO_LARGE: Discord rejected file as too large`);
  }
  if (response.status === 401 || response.status === 403) {
    rateLimiter.recordError(response.status);
    throw new Error(`AUTH_ERROR: Discord returned ${response.status} for webhook ${webhook.id}`);
  }
  const text = await response.text();
  throw new Error(
    `Discord streaming upload failed: ${response.status} ${response.statusText} — ${text}`,
  );
}
