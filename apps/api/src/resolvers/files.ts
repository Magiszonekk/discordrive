// DiscorDrive v4 — File resolvers (secure files v2)

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { db } from "@ddv4/database";
import { downloadChunk, getChunkUrl, parseWebhookUrls, WebhookRateLimiter, type WebhookInfo, downloadChunkBot, getChunkUrlBot, type BotInfo } from "@ddv4/discord-client";
import type { InitSecureUploadRequest, UploadedBlobTransportInput } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

export async function initUpload(
  ownerUserId: string,
  input: InitSecureUploadRequest,
): Promise<{ fileId: string; status: "uploading" }> {
  const file = await db.file.create({
    data: {
      ownerUserId,
      parentFolderId: input.parentFolderId ?? null,
      encryptedName: input.encryptedName ?? null,
      encryptedMimeType: input.encryptedMimeType ?? null,
      primaryManifestBlobId: null,
      wrappedFEK: Buffer.from(input.wrappedFEK, "base64"),
      status: "UPLOADING",
      totalCiphertextBytes: BigInt(input.totalCiphertextBytes),
      chunkCount: input.chunkCount,
    },
  });

  return { fileId: file.id, status: "uploading" };
}

export async function commitManifest(
  ownerUserId: string,
  fileId: string,
  manifestBlobId: string,
  totalCiphertextBytes: string,
  chunkCount: number,
  blobs: UploadedBlobTransportInput[],
): Promise<{ success: boolean }> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");
  if (file.status !== "UPLOADING") throw new Error("File is not in UPLOADING state");

  const manifestBlob = blobs.find((blob) => blob.blobId === manifestBlobId);
  if (!manifestBlob) throw new Error("Manifest blob not found in commit payload");

  await db.$transaction(async (tx) => {
    await tx.blobTransport.createMany({
      data: blobs.map((blob) => ({
        blobId: blob.blobId,
        ownerUserId,
        storageKind: blob.storageKind,
        storagePath: blob.storagePath,
        discordMessageId: blob.discordMessageId ?? null,
        discordChannelId: blob.discordChannelId ?? null,
        webhookId: blob.webhookId ?? null,
        ciphertextSizeBytes: BigInt(blob.ciphertextSizeBytes),
        ciphertextHash: blob.ciphertextHash ?? null,
        healthStatus: null,
        healthCheckedAt: null,
      })),
    });

    await tx.file.update({
      where: { id: fileId },
      data: {
        primaryManifestBlobId: manifestBlobId,
        totalCiphertextBytes: BigInt(totalCiphertextBytes),
        chunkCount,
        status: "READY",
      },
    });
  });

  await pluginRegistry.emitAsync("file:uploaded", {
    fileId,
    userId: ownerUserId,
    mimeType: "application/octet-stream",
    size: BigInt(totalCiphertextBytes),
    sha256: manifestBlobId,
  });

  return { success: true };
}

export async function deleteFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  await db.file.update({
    where: { id: fileId },
    data: { deletedAt: new Date() },
  });

  await db.shareWrappedObjectKey.deleteMany({ where: { fileId } });
  await pluginRegistry.emitAsync("file:deleted", { fileId, userId: ownerUserId });
  return true;
}

export async function moveFile(
  ownerUserId: string,
  fileId: string,
  parentFolderId: string | null,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  if (parentFolderId) {
    const folder = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!folder) throw new Error("Folder not found");
  }

  await db.file.update({ where: { id: fileId }, data: { parentFolderId } });
  return true;
}

export async function getFiles(ownerUserId: string, parentFolderId: string | null) {
  return db.file.findMany({
    where: { ownerUserId, parentFolderId, deletedAt: null, status: "READY" },
    orderBy: { createdAt: "desc" },
  });
}

export async function getFile(ownerUserId: string, fileId: string) {
  return db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: null } });
}

export async function getStorageUsage(ownerUserId: string) {
  const result = await db.file.aggregate({
    where: { ownerUserId, deletedAt: null, status: "READY" },
    _sum: { totalCiphertextBytes: true },
    _count: true,
  });

  return {
    totalBytes: (result._sum.totalCiphertextBytes ?? BigInt(0)).toString(),
    fileCount: result._count,
  };
}


type HealthCheckChunkStatus = "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED";

type HealthCheckChunkInfo = {
  id: string;
  index: number;
  storageKind: "LOCAL" | "DISCORD";
  storagePath: string;
  messageId: string;
  webhookId: string;
  channelId: string | null;
  size: number;
  encryptedHash: string | null;
  healthStatus: string | null;
  healthCheckedAt: string | null;
};

type HealthCheckFileInfo = {
  fileId: string;
  fileName: string;
  chunkCount: number;
  chunks: HealthCheckChunkInfo[];
};

type HealthCheckSummary = {
  checked: number;
  healthy: number;
  missing: number;
  modified: number;
  skipped: number;
  durationMs: number;
};

type ChunkHealthUpdate = {
  chunkId: string;
  status: Exclude<HealthCheckChunkStatus, "SKIPPED">;
};

function parseChunkIndex(blobId: string): number {
  const m = /:chunk:(\d+)$/.exec(blobId);
  return m ? Number(m[1]) : 0;
}

async function runTasksWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function getFilesForHealthCheckDisplay(
  ownerUserId: string,
): Promise<HealthCheckFileInfo[]> {
  const files = await db.file.findMany({
    where: { ownerUserId, deletedAt: null, status: "READY" },
    select: { id: true, chunkCount: true },
    orderBy: { createdAt: "desc" },
  });

  const result = await Promise.all(files.map(async (file) => {
    const chunks = await db.blobTransport.findMany({
      where: { ownerUserId, blobId: { startsWith: `${file.id}:chunk:` } },
      select: { blobId: true, healthStatus: true, healthCheckedAt: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      fileId: file.id,
      fileName: file.id,
      chunkCount: file.chunkCount,
      chunks: chunks.map((chunk) => ({
        id: chunk.blobId,
        index: parseChunkIndex(chunk.blobId),
        storageKind: "DISCORD" as const,
        storagePath: "",
        messageId: "",
        webhookId: "",
        channelId: null,
        size: 0,
        encryptedHash: null,
        healthStatus: chunk.healthStatus ?? null,
        healthCheckedAt: chunk.healthCheckedAt ? chunk.healthCheckedAt.toISOString() : null,
      })),
    } satisfies HealthCheckFileInfo;
  }));

  return result;
}

export async function getFilesForHealthCheck(
  ownerUserId: string,
  samplePercent?: number | null,
  fileId?: string | null,
): Promise<HealthCheckFileInfo[]> {
  let files = await db.file.findMany({
    where: {
      ownerUserId,
      deletedAt: null,
      status: "READY",
      ...(fileId ? { id: fileId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const pct = samplePercent ?? 100;
  if (!fileId && pct < 100) {
    const sampleSize = Math.max(1, Math.ceil(files.length * (pct / 100)));
    files = files
      .map((file) => ({ sortKey: Math.random(), file }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(0, sampleSize)
      .map((entry) => entry.file);
  }

  const result = await Promise.all(files.map(async (file) => {
    const chunks = await db.blobTransport.findMany({
      where: {
        ownerUserId,
        blobId: { startsWith: `${file.id}:chunk:` },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      fileId: file.id,
      fileName: file.id,
      chunkCount: file.chunkCount,
      chunks: chunks
        .map((chunk) => ({
          id: chunk.blobId,
          index: parseChunkIndex(chunk.blobId),
          storageKind: chunk.storageKind,
          storagePath: chunk.storagePath,
          messageId: chunk.discordMessageId ?? "",
          webhookId: chunk.webhookId ?? "",
          channelId: chunk.discordChannelId ?? null,
          size: Number(chunk.ciphertextSizeBytes),
          encryptedHash: chunk.ciphertextHash ?? null,
          healthStatus: chunk.healthStatus ?? null,
          healthCheckedAt: chunk.healthCheckedAt ? chunk.healthCheckedAt.toISOString() : null,
        }))
        .sort((a, b) => a.index - b.index),
    } satisfies HealthCheckFileInfo;
  }));

  return result;
}

export async function updateChunkHealthBatch(
  ownerUserId: string,
  updates: ChunkHealthUpdate[],
): Promise<boolean> {
  const checkedAt = new Date();
  await db.$transaction(
    updates.map((update) =>
      db.blobTransport.updateMany({
        where: { blobId: update.chunkId, ownerUserId },
        data: { healthStatus: update.status, healthCheckedAt: checkedAt },
      }),
    ),
  );
  return true;
}

export async function runHealthCheck(
  ownerUserId: string,
  mode: string,
  samplePercent?: number | null,
  fileId?: string | null,
): Promise<HealthCheckSummary> {
  if (mode !== "exists" && mode !== "integrity") {
    throw new Error('Invalid health check mode. Use "exists" or "integrity".');
  }

  const files = await getFilesForHealthCheck(ownerUserId, samplePercent, fileId);
  const allChunks = files.flatMap((file) => file.chunks.map((chunk) => ({ ...chunk, fileId: file.fileId, fileName: file.fileName })));

  const webhookUrls = Object.entries(process.env)
    .filter(([key]) => /^WEBHOOK_\d+$/.test(key))
    .map(([, value]) => value as string)
    .filter(Boolean);

  if (webhookUrls.length === 0) {
    throw new Error("No WEBHOOK_* env vars found.");
  }

  const webhookMap = new Map<string, WebhookInfo>(parseWebhookUrls(webhookUrls).map((w) => [w.id, w]));

  // Build bot map from BOT_n + BOT_n_CHANNEL env vars
  const botMap = new Map<string, BotInfo>();
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`BOT_${i}`]?.trim();
    const channelId = process.env[`BOT_${i}_CHANNEL`]?.trim();
    if (token && channelId) {
      botMap.set(`BOT_${i}`, { id: `BOT_${i}`, token, channelId });
    }
  }

  const rateLimiter = new WebhookRateLimiter();
  const startedAt = performance.now();

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 50;
  const CHUNK_TIMEOUT_MS = 60_000;
  const RUN_TIMEOUT_MS = 5 * 60 * 1000;

  type ChunkResult = { chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED" };

  const abortController = new AbortController();
  const runTimeoutHandle = setTimeout(() => abortController.abort(), RUN_TIMEOUT_MS);

  const checkChunk = async (chunk: typeof allChunks[number]): Promise<ChunkResult> => {
    if (abortController.signal.aborted) return { chunkId: chunk.id, status: "SKIPPED" };
    try {
      if (chunk.storageKind === "LOCAL") {
        if (mode === "exists") {
          await stat(chunk.storagePath);
          return { chunkId: chunk.id, status: "HEALTHY" };
        }
        if (!chunk.encryptedHash) return { chunkId: chunk.id, status: "SKIPPED" };
        const data = await readFile(chunk.storagePath);
        const hash = createHash("sha256").update(data).digest("hex");
        return { chunkId: chunk.id, status: hash === chunk.encryptedHash ? "HEALTHY" : "MODIFIED" };
      }

      if (chunk.webhookId.startsWith("BOT_")) {
        const bot = botMap.get(chunk.webhookId);
        if (!bot) return { chunkId: chunk.id, status: "SKIPPED" };
        const botChannelId = chunk.channelId ?? bot.channelId;
        if (mode === "exists") {
          await getChunkUrlBot(bot, chunk.messageId, botChannelId, rateLimiter);
          return { chunkId: chunk.id, status: "HEALTHY" };
        }
        if (!chunk.encryptedHash) return { chunkId: chunk.id, status: "SKIPPED" };
        const stream = await downloadChunkBot(bot, chunk.messageId, botChannelId, rateLimiter);
        const reader = stream.getReader();
        const hasher = createHash("sha256");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
        }
        const hash = hasher.digest("hex");
        return { chunkId: chunk.id, status: hash === chunk.encryptedHash ? "HEALTHY" : "MODIFIED" };
      }

      const webhook = webhookMap.get(chunk.webhookId);
      if (!webhook) return { chunkId: chunk.id, status: "SKIPPED" };
      if (mode === "exists") {
        await getChunkUrl(webhook, chunk.messageId, rateLimiter);
        return { chunkId: chunk.id, status: "HEALTHY" };
      }
      if (!chunk.encryptedHash) return { chunkId: chunk.id, status: "SKIPPED" };
      const stream = await downloadChunk(webhook, chunk.messageId, rateLimiter);
      const reader = stream.getReader();
      const hasher = createHash("sha256");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      const hash = hasher.digest("hex");
      return { chunkId: chunk.id, status: hash === chunk.encryptedHash ? "HEALTHY" : "MODIFIED" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const isNotFound = msg.includes("not found") || msg.includes("404");
      return { chunkId: chunk.id, status: isNotFound ? "MISSING" : "SKIPPED" };
    }
  };

  const allResults: ChunkResult[] = [];
  const pendingFlush: Array<{ chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" }> = [];
  let cursor = 0;

  const flushPending = async () => {
    if (pendingFlush.length === 0) return;
    const batch = pendingFlush.splice(0, pendingFlush.length);
    await updateChunkHealthBatch(ownerUserId, batch);
  };

  const checkChunkWithTimeout = (chunk: typeof allChunks[number]): Promise<ChunkResult> =>
    Promise.race([
      checkChunk(chunk),
      new Promise<ChunkResult>((resolve) =>
        setTimeout(() => resolve({ chunkId: chunk.id, status: "SKIPPED" }), CHUNK_TIMEOUT_MS),
      ),
    ]);

  const worker = async () => {
    while (true) {
      if (abortController.signal.aborted) break;
      const i = cursor++;
      if (i >= allChunks.length) break;
      const result = await checkChunkWithTimeout(allChunks[i]!);
      allResults.push(result);
      if (result.status !== "SKIPPED") {
        pendingFlush.push({ chunkId: result.chunkId, status: result.status });
        if (pendingFlush.length >= FLUSH_EVERY) await flushPending();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allChunks.length || 1) }, worker));
  clearTimeout(runTimeoutHandle);
  await flushPending();

  return {
    checked: allResults.filter((r) => r.status !== "SKIPPED").length,
    healthy: allResults.filter((r) => r.status === "HEALTHY").length,
    missing: allResults.filter((r) => r.status === "MISSING").length,
    modified: allResults.filter((r) => r.status === "MODIFIED").length,
    skipped: allResults.filter((r) => r.status === "SKIPPED").length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
