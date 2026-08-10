// DiscorDrive v4 — File resolvers (secure files v2)

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { db } from "@ddv4/database";
import { downloadChunk, getChunkUrl, parseWebhookUrls, WebhookRateLimiter, type WebhookInfo, downloadChunkBot, getChunkUrlBot, type BotInfo } from "@ddv4/discord-client";
import { getPoolFor, placementFromBlobRecord, placementFromRow, type PlacementRow, type PoolRole } from "../storage/provider.js";
import { getConfiguredReplicaKinds } from "../storage/replica-pools.js";
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
      wrappedFEKPreview: input.wrappedFEKPreview ? Buffer.from(input.wrappedFEKPreview, "base64") : null,
      dedupeTokenB64: input.dedupeTokenB64 ?? null,
      status: "UPLOADING",
      totalCiphertextBytes: BigInt(input.totalCiphertextBytes),
      chunkCount: input.chunkCount,
    },
  });

  return { fileId: file.id, status: "uploading" };
}

// Dedupe lookup: the token is HMAC(per-user dedupe key, content hash) computed
// client-side, so the server can match equality without learning the content
// hash itself. Returns the existing live file for that token, if any.
export async function getFileByDedupeToken(ownerUserId: string, dedupeTokenB64: string) {
  return db.file.findFirst({
    where: { ownerUserId, dedupeTokenB64, deletedAt: null, status: "READY" },
  });
}

// Attaches a client-generated, client-encrypted low-res preview to a file.
// The preview blob must already be uploaded (PUT /api/blob/{previewBlobId}).
export async function setFilePreview(
  ownerUserId: string,
  fileId: string,
  previewBlobId: string,
  wrappedFEKPreview: string,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  const blob = await db.blobTransport.findUnique({ where: { blobId: previewBlobId } });
  if (!blob || blob.ownerUserId !== ownerUserId) throw new Error("Preview blob not found");

  await db.file.update({
    where: { id: fileId },
    data: {
      previewBlobId,
      wrappedFEKPreview: Buffer.from(wrappedFEKPreview, "base64"),
    },
  });
  return true;
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
    // Blob records are normally already written by the upload handler;
    // skipDuplicates keeps those server-written rows authoritative and only
    // fills in any the handler may have missed.
    await tx.blobTransport.createMany({
      skipDuplicates: true,
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

    // Same catch-up for placements (unique on blobId+provider+poolRole).
    await tx.blobPlacement.createMany({
      skipDuplicates: true,
      data: blobs.map((blob) => ({
        blobId: blob.blobId,
        provider: blob.storageKind,
        poolRole: "PRIMARY" as const,
        status: "ACTIVE" as const,
        storagePath: blob.storagePath,
        messageId: blob.discordMessageId ?? null,
        locationId: blob.discordChannelId ?? null,
        senderId: blob.webhookId ?? null,
        activatedAt: new Date(),
      })),
    });

    // Queue replica copies for any blob that slipped past the upload handler
    const replicaKinds = getConfiguredReplicaKinds();
    if (replicaKinds.length > 0) {
      await tx.blobPlacement.createMany({
        skipDuplicates: true,
        data: blobs.flatMap((blob) =>
          replicaKinds.map((kind) => ({
            blobId: blob.blobId,
            provider: kind,
            poolRole: "REPLICA" as const,
            status: "PENDING" as const,
            storagePath: "pending://replica",
          })),
        ),
      });
    }

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

// Resume support: reports which chunk blobs of an UPLOADING file already made
// it to storage, so a client can skip them on retry instead of re-uploading.
export async function getUploadStatus(ownerUserId: string, fileId: string) {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  const blobs = await db.blobTransport.findMany({
    where: { ownerUserId, blobId: { startsWith: `${fileId}:` } },
    select: { blobId: true },
  });

  const uploadedChunkIndices: number[] = [];
  let hasManifest = false;
  for (const blob of blobs) {
    if (blob.blobId === `${fileId}:manifest`) {
      hasManifest = true;
      continue;
    }
    const match = blob.blobId.match(/:chunk:(\d+)$/);
    if (match) uploadedChunkIndices.push(Number(match[1]));
  }
  uploadedChunkIndices.sort((a, b) => a - b);

  return {
    fileId,
    status: file.status,
    chunkCount: file.chunkCount,
    uploadedChunkIndices,
    hasManifest,
  };
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

// === Trash ===

type PurgeableFile = { id: string; ownerUserId: string; previewBlobId: string | null };
type PurgeableBlob = {
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId: string | null;
  discordChannelId: string | null;
  webhookId: string | null;
  placements?: PlacementRow[];
};

// Best-effort physical deletion of every copy of every blob. Failures are
// logged, not thrown: a purge must never be blocked by an already-deleted
// Discord message or missing local file.
async function deleteBlobsBestEffort(blobs: PurgeableBlob[]): Promise<void> {
  const warn = (blobId: string, error: unknown) =>
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      scope: "trash-purge",
      type: "blob_delete_failed",
      blobId,
      error: error instanceof Error ? error.message : String(error),
    }));

  for (const blob of blobs) {
    const placements = blob.placements ?? [];
    if (placements.length === 0) {
      // Row predates the placement backfill — legacy columns are all we have.
      try {
        await getPoolFor(blob.storageKind).delete(placementFromBlobRecord(blob));
      } catch (error) {
        warn(blob.blobId, error);
      }
      continue;
    }

    for (const placement of placements) {
      // PENDING rows have no physical copy yet; their DB row is removed by the
      // caller's cascade delete, which also dequeues them from replication.
      if (placement.status === "PENDING" && !placement.messageId) continue;
      try {
        await getPoolFor(placement.provider, placement.poolRole as PoolRole).delete(
          placementFromRow(blob.blobId, blob.ownerUserId, placement),
        );
      } catch (error) {
        warn(blob.blobId, error);
      }
    }
  }
}

async function purgeFileRecord(file: PurgeableFile): Promise<void> {
  const blobs = await db.blobTransport.findMany({
    where: {
      ownerUserId: file.ownerUserId,
      OR: [
        { blobId: { startsWith: `${file.id}:` } },
        ...(file.previewBlobId ? [{ blobId: file.previewBlobId }] : []),
      ],
    },
    include: { placements: true },
  });

  await deleteBlobsBestEffort(blobs);

  await db.$transaction([
    db.blobTransport.deleteMany({ where: { blobId: { in: blobs.map((b) => b.blobId) } } }),
    db.shareWrappedObjectKey.deleteMany({ where: { fileId: file.id } }),
    db.file.delete({ where: { id: file.id } }),
  ]);
}

export async function getTrashedFiles(ownerUserId: string) {
  return db.file.findMany({
    where: { ownerUserId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
  });
}

export async function restoreFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: { not: null } } });
  if (!file) throw new Error("File not found in trash");

  // If the original folder was deleted in the meantime, restore to root.
  let parentFolderId = file.parentFolderId;
  if (parentFolderId) {
    const parent = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!parent) parentFolderId = null;
  }

  await db.file.update({ where: { id: fileId }, data: { deletedAt: null, parentFolderId } });
  return true;
}

export async function purgeFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: { not: null } } });
  if (!file) throw new Error("File not found in trash");
  await purgeFileRecord(file);
  return true;
}

export async function emptyTrash(ownerUserId: string): Promise<number> {
  const files = await db.file.findMany({ where: { ownerUserId, deletedAt: { not: null } } });
  for (const file of files) await purgeFileRecord(file);
  return files.length;
}

// Permanently removes trashed files past the retention window. Runs across all
// users — invoked from the server's periodic sweep, not from user requests.
export async function purgeExpiredTrash(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const files = await db.file.findMany({ where: { deletedAt: { lt: cutoff } } });

  let purged = 0;
  for (const file of files) {
    try {
      await purgeFileRecord(file);
      purged++;
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "trash-purge",
        type: "file_purge_failed",
        fileId: file.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
}

// === Abandoned uploads ===

/**
 * Uploads that died mid-flight — the tab crashed, the network dropped, the
 * client never reached commitManifest. Their File row stays UPLOADING forever:
 * invisible to getFiles and to the storage-usage total, while the chunks that
 * did land keep occupying provider storage with nothing left to reference them.
 *
 * Staleness is measured from the last chunk that actually arrived, never from
 * creation — a slow multi-hour upload is still making progress and must not be
 * swept out from under itself.
 */
export async function findStaleUploads(
  staleAfterMinutes = 60,
): Promise<Array<{ id: string; lastActivityAt: Date; blobCount: number }>> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);

  // A file created after the cutoff cannot be stale (last activity >= creation),
  // so the CTE prefilter is safe and keeps the unindexable LIKE join small.
  return db.$queryRaw<Array<{ id: string; lastActivityAt: Date; blobCount: number }>>`
    WITH candidates AS (
      SELECT id, "createdAt" FROM "File"
      WHERE status = 'UPLOADING' AND "deletedAt" IS NULL AND "createdAt" < ${cutoff}
    )
    SELECT c.id,
           COALESCE(MAX(bt."createdAt"), c."createdAt") AS "lastActivityAt",
           COUNT(bt."blobId")::int                      AS "blobCount"
    FROM candidates c
    LEFT JOIN "BlobTransport" bt ON bt."blobId" LIKE c.id || ':%'
    GROUP BY c.id, c."createdAt"
    HAVING COALESCE(MAX(bt."createdAt"), c."createdAt") < ${cutoff}
  `;
}

export async function purgeStaleUploads(staleAfterMinutes = 60): Promise<number> {
  const stale = await findStaleUploads(staleAfterMinutes);

  let purged = 0;
  for (const { id } of stale) {
    // Re-read under the current state: an upload can commit between the scan
    // and the purge, and a committed file must never be swept.
    const file = await db.file.findUnique({ where: { id } });
    if (!file || file.status !== "UPLOADING" || file.deletedAt) continue;

    try {
      await purgeFileRecord(file);
      purged++;
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "stale-upload-sweep",
        type: "file_purge_failed",
        fileId: id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
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
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
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

// Prisma's connection pool defaults to num_cpus*2+1 (9 on this box). A
// Promise.all over every file fired one findMany() per file simultaneously —
// fine for a handful of files, but an account with thousands (seen in
// production: 4779) opened thousands of concurrent queries against a 9-slot
// pool, starving every other request on the box until pending ones hit the
// 10s pool-checkout timeout. Bounding this to the same concurrency the
// Discord-side health check already uses (see CONCURRENCY below) keeps this
// query well under the pool size regardless of account size.
const FILES_HEALTH_CHECK_DB_CONCURRENCY = 5;

export async function getFilesForHealthCheckDisplay(
  ownerUserId: string,
): Promise<HealthCheckFileInfo[]> {
  const files = await db.file.findMany({
    where: { ownerUserId, deletedAt: null, status: "READY" },
    select: { id: true, chunkCount: true },
    orderBy: { createdAt: "desc" },
  });

  const result = await runTasksWithConcurrency(files.map((file) => async () => {
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
  }), FILES_HEALTH_CHECK_DB_CONCURRENCY);

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

  const result = await runTasksWithConcurrency(files.map((file) => async () => {
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
  }), FILES_HEALTH_CHECK_DB_CONCURRENCY);

  return result;
}

export async function updateChunkHealthBatch(
  ownerUserId: string,
  updates: ChunkHealthUpdate[],
): Promise<boolean> {
  const checkedAt = new Date();
  // Placement status mirrors chunk health: a HEALTHY check re-activates,
  // MISSING/MODIFIED park the placement so reads prefer other copies.
  const placementStatus = { HEALTHY: "ACTIVE", MISSING: "MISSING", MODIFIED: "MODIFIED" } as const;
  await db.$transaction(
    updates.flatMap((update) => [
      db.blobTransport.updateMany({
        where: { blobId: update.chunkId, ownerUserId },
        data: { healthStatus: update.status, healthCheckedAt: checkedAt },
      }),
      db.blobPlacement.updateMany({
        where: {
          blobId: update.chunkId,
          poolRole: "PRIMARY",
          blob: { ownerUserId },
          // Never resurrect queue states from a health sweep
          status: { in: ["ACTIVE", "MISSING", "MODIFIED"] },
        },
        data: { status: placementStatus[update.status], healthCheckedAt: checkedAt },
      }),
    ]),
  );
  return true;
}

// === Replication status (HealthCheck page metrics) ===

export async function getReplicationStatus(ownerUserId: string) {
  const [groups, oldestPending, failedPlacements] = await Promise.all([
    db.blobPlacement.groupBy({
      by: ["provider", "poolRole", "status"],
      where: { blob: { ownerUserId } },
      _count: { _all: true },
    }),
    db.blobPlacement.findFirst({
      where: { blob: { ownerUserId }, status: { in: ["PENDING", "MISSING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.blobPlacement.count({
      where: { blob: { ownerUserId }, status: { in: ["PENDING", "MISSING"] }, attemptCount: { gte: 8 } },
    }),
  ]);

  const replicaKinds = getConfiguredReplicaKinds();
  const queueDepth = groups
    .filter((g) => g.status === "PENDING" || g.status === "MISSING")
    .reduce((sum, g) => sum + g._count._all, 0);

  return {
    enabled: replicaKinds.length > 0,
    replicaProviders: replicaKinds,
    queueDepth,
    oldestQueuedAgeSeconds: oldestPending
      ? Math.floor((Date.now() - oldestPending.createdAt.getTime()) / 1000)
      : null,
    failedPlacements,
    placements: groups.map((g) => ({
      provider: g.provider,
      poolRole: g.poolRole,
      status: g.status,
      count: g._count._all,
    })),
  };
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
