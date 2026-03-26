// DiscorDrive v4 — Download handler
// GET /api/download/:fileId/chunk/:index
// Fetches fresh CDN URL from Discord, streams chunk to client.

import { db } from "@ddv4/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  downloadChunk,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";
import { authenticateRequestAny } from "../middleware/auth.js";

const rateLimiter = new WebhookRateLimiter();

let webhooks: ReturnType<typeof parseWebhookUrls> | null = null;
function getWebhooks() {
  if (!webhooks) {
    webhooks = parseWebhookUrls(serverConfig.webhooks);
  }
  return webhooks;
}

export async function handleDownload(
  request: Request,
  params: { fileId: string; index: string },
): Promise<Response> {
  try {
    const auth = await authenticateRequestAny(request);
    const { fileId } = params;
    const chunkIndex = parseInt(params.index, 10);

    // Verify file belongs to user
    const file = await db.file.findFirst({
      where: { id: fileId, userId: auth.userId, status: "READY" },
    });

    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    // Get chunk metadata
    const chunk = await db.chunk.findUnique({
      where: { fileId_index: { fileId, index: chunkIndex } },
    });

    if (!chunk) {
      return Response.json({ error: "Chunk not found" }, { status: 404 });
    }

    // Find webhook for this chunk
    const whs = getWebhooks();
    const webhook = whs.find((w) => w.id === chunk.webhookId);
    if (!webhook) {
      return Response.json({ error: "Webhook not available" }, { status: 503 });
    }

    // Get fresh CDN URL and stream (retries on transient CDN errors)
    const stream = await downloadChunk(webhook, chunk.messageId, rateLimiter);

    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": chunk.size.toString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
