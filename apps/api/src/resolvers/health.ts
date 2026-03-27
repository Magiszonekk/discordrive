// DiscorDrive v4 — Health check resolver
// Verifies chunks exist on Discord and optionally checks integrity via encrypted hash.

import { db } from "@ddv4/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  getChunkUrl,
  downloadChunk,
  type WebhookInfo,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";
import { createHash } from "node:crypto";

export type HealthStatus = "HEALTHY" | "MISSING" | "MODIFIED";

let webhooks: WebhookInfo[] | null = null;
function getWebhooks(): WebhookInfo[] {
  if (!webhooks) webhooks = parseWebhookUrls(serverConfig.webhooks);
  return webhooks;
}

// === Queries ===

export async function getFilesForHealthCheck(
  userId: string,
  samplePercent?: number,
) {
  const files = await db.file.findMany({
    where: { userId, status: "READY" },
    include: { chunks: true },
    orderBy: { createdAt: "asc" },
  });

  let selected = files;
  if (samplePercent !== undefined && samplePercent < 100) {
    const count = Math.max(1, Math.round((samplePercent / 100) * files.length));
    // Shuffle and take first `count`
    const shuffled = [...files].sort(() => Math.random() - 0.5);
    selected = shuffled.slice(0, count);
  }

  return selected.map((f) => ({
    fileId: f.id,
    fileName: f.name,
    chunkCount: f.chunkCount,
    chunks: f.chunks.map((c) => ({
      id: c.id,
      index: c.index,
      messageId: c.messageId,
      webhookId: c.webhookId,
      size: c.size,
      encryptedHash: c.encryptedHash,
      healthStatus: c.healthStatus,
      healthCheckedAt: c.healthCheckedAt,
    })),
  }));
}

// === Mutations ===

export async function updateChunkHealthBatch(
  updates: Array<{ chunkId: string; status: string }>,
): Promise<number> {
  const now = new Date();
  await Promise.all(
    updates.map(({ chunkId, status }) =>
      db.chunk.update({
        where: { id: chunkId },
        data: { healthStatus: status, healthCheckedAt: now },
      }),
    ),
  );
  return updates.length;
}

// === Server-side health check ===

export async function runHealthCheck(
  userId: string,
  mode: string,
  samplePercent?: number,
  fileId?: string,
): Promise<{
  checked: number;
  healthy: number;
  missing: number;
  modified: number;
  skipped: number;
  durationMs: number;
}> {
  const start = Date.now();

  if (mode !== "exists" && mode !== "integrity") {
    throw new Error(`Invalid mode "${mode}". Use "exists" or "integrity".`);
  }

  const whs = getWebhooks();
  const webhookMap = new Map<string, WebhookInfo>(whs.map((w) => [w.id, w]));
  const rateLimiter = new WebhookRateLimiter();

  // Load chunks
  const where = fileId
    ? { fileId, file: { userId } }
    : { file: { userId, status: "READY" as const } };

  const allChunks = await db.chunk.findMany({
    where,
    select: {
      id: true,
      messageId: true,
      webhookId: true,
      encryptedHash: true,
    },
  });

  // Apply sampling (per file, not per chunk) when no specific fileId given
  let chunksToCheck = allChunks;
  if (!fileId && samplePercent !== undefined && samplePercent < 100) {
    // Group by implicit fileId sampling — sample done at query level via getFilesForHealthCheck
    // Here, sample by taking a proportion of chunks
    const count = Math.max(1, Math.round((samplePercent / 100) * allChunks.length));
    chunksToCheck = [...allChunks].sort(() => Math.random() - 0.5).slice(0, count);
  }

  let healthy = 0;
  let missing = 0;
  let modified = 0;
  let skipped = 0;
  const now = new Date();

  // Process concurrently in batches of 5
  const CONCURRENCY = 5;
  const queue = [...chunksToCheck];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (!chunk) break;

      const webhook = webhookMap.get(chunk.webhookId);
      if (!webhook) {
        skipped++;
        continue;
      }

      let status: HealthStatus;

      try {
        if (mode === "exists") {
          await getChunkUrl(webhook, chunk.messageId, rateLimiter);
          status = "HEALTHY";
        } else {
          // integrity mode
          if (!chunk.encryptedHash) {
            skipped++;
            continue;
          }
          const stream = await downloadChunk(webhook, chunk.messageId, rateLimiter);
          const reader = stream.getReader();
          const hasher = createHash("sha256");
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            hasher.update(value);
          }
          const hash = hasher.digest("hex");
          status = hash === chunk.encryptedHash ? "HEALTHY" : "MODIFIED";
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status = msg.includes("not found") || msg.includes("404") ? "MISSING" : "MISSING";
      }

      if (status === "HEALTHY") healthy++;
      else if (status === "MISSING") missing++;
      else modified++;

      await db.chunk.update({
        where: { id: chunk.id },
        data: { healthStatus: status, healthCheckedAt: now },
      });
    }
  });

  await Promise.all(workers);

  return {
    checked: healthy + missing + modified,
    healthy,
    missing,
    modified,
    skipped,
    durationMs: Date.now() - start,
  };
}
