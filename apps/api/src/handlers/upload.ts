// DiscorDrive v4 — Upload handler
// POST /api/upload/:fileId/chunk/:index
// Receives encrypted chunk (binary body), forwards to Discord webhook, saves metadata.

import { db } from "@ddv4/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  uploadChunk,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";
import { authenticateRequestAny } from "../middleware/auth.js";

const rateLimiter = new WebhookRateLimiter();
const debugUpload = process.env.DEBUG_UPLOAD === "1";

let activeUploads = 0;
let peakUploads = 0;

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
  activeUploads++;
  if (activeUploads > peakUploads) peakUploads = activeUploads;
  try {
    const t0 = performance.now();
    const auth = await authenticateRequestAny(request);
    const t1 = performance.now();

    const { fileId } = params;
    const chunkIndex = parseInt(params.index, 10);

    // Verify file belongs to user and is in UPLOADING state
    const file = await db.file.findFirst({
      where: { id: fileId, userId: auth.userId, status: "UPLOADING" },
    });
    const t2 = performance.now();

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
    const t3 = performance.now();

    if (existing) {
      return Response.json({ error: "Chunk already uploaded" }, { status: 409 });
    }

    // Buffer the request body
    const body = await request.arrayBuffer();
    const t4 = performance.now();

    if (!body.byteLength) {
      return Response.json({ error: "Empty body" }, { status: 400 });
    }

    // Select webhook (pre-flight rate-limit check)
    const whs = getWebhooks();
    const webhookIds = whs.map((w) => w.id);
    const selectedId = await rateLimiter.waitForAvailable(webhookIds);
    const t5 = performance.now();
    const webhook = whs.find((w) => w.id === selectedId)!;

    // Upload buffered chunk to Discord
    const result = await uploadChunk(
      webhook,
      body,
      `${fileId}_${chunkIndex}.enc`,
      rateLimiter,
    );
    const t6 = performance.now();

    // Save chunk metadata to DB
    await db.chunk.create({
      data: {
        fileId,
        index: chunkIndex,
        messageId: result.messageId,
        channelId: result.channelId,
        webhookId: webhook.id,
        size: body.byteLength,
      },
    });
    const t7 = performance.now();

    if (debugUpload) {
      const ms = (v: number) => v.toFixed(0);
      console.log(
        `[UPLOAD] chunk ${fileId.slice(-6)}/${chunkIndex}: auth=${ms(t1 - t0)}ms findFile=${ms(t2 - t1)}ms findChunk=${ms(t3 - t2)}ms readBody=${ms(t4 - t3)}ms waitWebhook=${ms(t5 - t4)}ms discord=${ms(t6 - t5)}ms saveChunk=${ms(t7 - t6)}ms total=${ms(t7 - t0)}ms size=${body.byteLength} active=${activeUploads} peak=${peakUploads}`,
      );
    }

    return Response.json({
      messageId: result.messageId,
      channelId: result.channelId,
      index: chunkIndex,
    });
  } catch (error) {
    console.error("Upload error:", error);
    const message = error instanceof Error ? error.message : "Upload failed";
    return Response.json({ error: message }, { status: 500 });
  } finally {
    activeUploads--;
  }
}
