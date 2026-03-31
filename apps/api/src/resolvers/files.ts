// DiscorDrive v4 — File resolvers

import { db } from "@discordrive/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  deleteChunk as discordDeleteChunk,
} from "@discordrive/discord-client";
import { serverConfig } from "@discordrive/config/server";
import type { InitUploadRequest } from "@discordrive/types/api";
import { pluginRegistry } from "../plugin-registry.js";

const rateLimiter = new WebhookRateLimiter();

export async function initUpload(
  userId: string,
  input: InitUploadRequest,
): Promise<{ fileId: string }> {
  const file = await db.file.create({
    data: {
      userId,
      folderId: input.folderId ?? null,
      name: input.name,
      mimeType: input.mimeType,
      size: BigInt(input.size),
      chunkSize: input.chunkSize,
      chunkCount: input.chunkCount,
      encryptedFEK: input.encryptedFEK,
      fekIv: input.fekIv,
      status: "UPLOADING",
    },
  });

  return { fileId: file.id };
}

export async function finalizeUpload(
  userId: string,
  fileId: string,
  sha256: string,
): Promise<{ success: boolean; missingChunks?: number[] }> {
  const file = await db.file.findFirst({
    where: { id: fileId, userId },
  });

  if (!file) throw new Error("File not found");
  if (file.status !== "UPLOADING") throw new Error("File is not in UPLOADING state");

  // Integrity check: verify all chunks exist
  const chunks = await db.chunk.findMany({
    where: { fileId },
    select: { index: true, messageId: true },
    orderBy: { index: "asc" },
  });

  const uploadedIndices = new Set(
    chunks.filter((c) => c.messageId).map((c) => c.index),
  );

  const missingChunks: number[] = [];
  for (let i = 0; i < file.chunkCount; i++) {
    if (!uploadedIndices.has(i)) {
      missingChunks.push(i);
    }
  }

  if (missingChunks.length > 0) {
    return { success: false, missingChunks };
  }

  const updated = await db.file.update({
    where: { id: fileId },
    data: { status: "READY", sha256 },
  });

  await pluginRegistry.emitAsync("file:uploaded", {
    fileId,
    userId,
    mimeType: updated.mimeType,
    size: updated.size,
    sha256,
  });

  return { success: true };
}

export async function deleteFile(userId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({
    where: { id: fileId, userId },
    include: { chunks: true },
  });

  if (!file) throw new Error("File not found");

  // Delete chunks from Discord (best effort)
  const webhooks = parseWebhookUrls(serverConfig.webhooks);
  const webhookMap = new Map(webhooks.map((w) => [w.id, w]));

  // Delete from DB first (cascades to chunks and share links)
  await db.file.delete({ where: { id: fileId } });

  await pluginRegistry.emitAsync("file:deleted", { fileId, userId });

  // Delete Discord messages in background — best effort, don't block response
  void Promise.allSettled(
    file.chunks.map(async (chunk) => {
      const webhook = webhookMap.get(chunk.webhookId);
      if (!webhook) return; // Webhook no longer configured
      try {
        await discordDeleteChunk(webhook, chunk.messageId, rateLimiter);
      } catch {
        // Best effort — chunk may already be deleted
      }
    }),
  );

  return true;
}

export async function moveFile(
  userId: string,
  fileId: string,
  folderId: string | null,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, userId } });
  if (!file) throw new Error("File not found");

  if (folderId) {
    const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
    if (!folder) throw new Error("Folder not found");
  }

  await db.file.update({
    where: { id: fileId },
    data: { folderId },
  });

  return true;
}

export async function renameFile(
  userId: string,
  fileId: string,
  name: string,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, userId } });
  if (!file) throw new Error("File not found");

  await db.file.update({
    where: { id: fileId },
    data: { name },
  });

  return true;
}

export async function getFiles(userId: string, folderId: string | null) {
  return db.file.findMany({
    where: { userId, folderId, status: "READY" },
    orderBy: { createdAt: "desc" },
  });
}

export async function getFile(userId: string, fileId: string) {
  return db.file.findFirst({
    where: { id: fileId, userId },
  });
}

export async function getStorageUsage(userId: string) {
  const result = await db.file.aggregate({
    where: { userId, status: "READY" },
    _sum: { size: true },
    _count: true,
  });

  return {
    totalBytes: (result._sum.size ?? BigInt(0)).toString(),
    fileCount: result._count,
  };
}
