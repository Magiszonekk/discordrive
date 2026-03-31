// DiscorDrive v4 — Upload handler
// POST /api/upload/:fileId/chunk/:index
// Receives encrypted chunk (binary body), forwards to Discord webhook, saves metadata.

import { db } from "@discordrive/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  uploadChunk,
} from "@discordrive/discord-client";
import { serverConfig } from "@discordrive/config/server";
import { authenticateRequestAny } from "../middleware/auth.js";
import { pluginRegistry } from "../plugin-registry.js";

const rateLimiter = new WebhookRateLimiter();

let webhooks: ReturnType<typeof parseWebhookUrls> | null = null;
function getWebhooks() {
  if (!webhooks) {
    webhooks = parseWebhookUrls(serverConfig.webhooks);
  }
  return webhooks;
}

export async function handleUpload(
  request: Request,
  params: { fileId: string; index: string },
): Promise<Response> {
  try {
    const auth = await authenticateRequestAny(request);
    const { fileId } = params;
    const chunkIndex = parseInt(params.index, 10);

    // Verify file belongs to user and is in UPLOADING state
    const file = await db.file.findFirst({
      where: { id: fileId, userId: auth.userId, status: "UPLOADING" },
    });

    if (!file) {
      return Response.json({ error: "File not found or not in uploading state" }, { status: 404 });
    }

    if (chunkIndex < 0 || chunkIndex >= file.chunkCount) {
      return Response.json({ error: "Invalid chunk index" }, { status: 400 });
    }

    // Check if chunk already uploaded
    const existing = await db.chunk.findUnique({
      where: { fileId_index: { fileId, index: chunkIndex } },
    });

    if (existing) {
      return Response.json({ error: "Chunk already uploaded" }, { status: 409 });
    }

    // Read binary body (already encrypted with prepended IV)
    const body = await request.arrayBuffer();
    if (!body.byteLength) {
      return Response.json({ error: "Empty body" }, { status: 400 });
    }

    // Hash encrypted chunk for integrity checks
    const hashBuffer = await crypto.subtle.digest("SHA-256", body);
    const encryptedHash = Buffer.from(hashBuffer).toString("hex");

    // Select webhook and upload to Discord
    const whs = getWebhooks();
    const webhookIds = whs.map((w) => w.id);
    const selectedId = await rateLimiter.waitForAvailable(webhookIds);
    const webhook = whs.find((w) => w.id === selectedId)!;

    const result = await uploadChunk(
      webhook,
      body,
      `${fileId}_${chunkIndex}.enc`,
      rateLimiter,
    );

    // Save chunk metadata to DB
    await db.chunk.create({
      data: {
        fileId,
        index: chunkIndex,
        messageId: result.messageId,
        channelId: result.channelId,
        webhookId: webhook.id,
        size: body.byteLength,
        encryptedHash,
      },
    });

    await pluginRegistry.emitAsync("chunk:uploaded", {
      fileId,
      index: chunkIndex,
      messageId: result.messageId,
    });

    return Response.json({
      messageId: result.messageId,
      channelId: result.channelId,
      index: chunkIndex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
