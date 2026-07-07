// DiscorDrive v4 — replication worker
//
// Drains the placement queue: PENDING/MISSING placements get a fresh copy
// written to their pool (REPLICA pools by default; a MISSING PRIMARY is healed
// the same way and its legacy BlobTransport mirror updated). Ciphertext is
// sourced from any readable copy — the worker never needs key material, so
// replication preserves the zero-knowledge property.
//
// Upload write-through calls processPlacement directly with the ciphertext
// still in memory; the durable PENDING row is the fallback when that fails.

import { createHash } from "node:crypto";
import { db } from "@ddv4/database";
import { getPoolFor, orderPlacementsForRead, placementFromRow, type PoolRole } from "./provider.js";
import { getConfiguredReplicaKinds } from "./replica-pools.js";

const MAX_ATTEMPTS = 8;
const DEFAULT_SWEEP_INTERVAL_MS = 10_000;
const SWEEP_BATCH_SIZE = 50;

function replicationConcurrency(): number {
  const raw = Number(process.env.REPLICATION_CONCURRENCY ?? "2");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

function backoffMs(attemptCount: number): number {
  return Math.min(2 ** attemptCount * 30_000, 6 * 60 * 60 * 1000);
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: "replication", ...event }));
}

type WorkRow = {
  id: string;
  blobId: string;
  provider: string;
  poolRole: string;
  status: string;
  storagePath: string;
  messageId: string | null;
  locationId: string | null;
  senderId: string | null;
  attemptCount: number;
  blob: {
    blobId: string;
    ownerUserId: string;
    ciphertextHash: string | null;
    storageKind: string;
    storagePath: string;
    discordMessageId: string | null;
    discordChannelId: string | null;
    webhookId: string | null;
  };
};

// Single-process guard against the sweep and a write-through racing on one row
const inFlight = new Set<string>();

/** Reads the ciphertext from any copy other than the target placement. */
async function readSourceBytes(row: WorkRow): Promise<Uint8Array> {
  const siblings = await db.blobPlacement.findMany({
    where: { blobId: row.blobId, id: { not: row.id } },
  });
  const candidates = orderPlacementsForRead(siblings);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await getPoolFor(candidate.provider, candidate.poolRole as PoolRole).get(
        placementFromRow(row.blobId, row.blob.ownerUserId, candidate),
      );
    } catch (error) {
      lastError = error;
    }
  }

  // Legacy-mirror fallback for rows that predate the placement backfill
  try {
    return await getPoolFor(row.blob.storageKind).get({
      blobId: row.blobId,
      ownerUserId: row.blob.ownerUserId,
      provider: row.blob.storageKind as never,
      storagePath: row.blob.storagePath,
      messageId: row.blob.discordMessageId,
      locationId: row.blob.discordChannelId,
      senderId: row.blob.webhookId,
    });
  } catch (error) {
    throw lastError ?? error;
  }
}

/**
 * Writes one fresh copy for a queued placement. `bytes` short-circuits the
 * source read (upload write-through). Returns true when the placement became
 * ACTIVE.
 */
export async function processPlacement(row: WorkRow, bytes?: Uint8Array): Promise<boolean> {
  if (inFlight.has(row.id)) return false;
  inFlight.add(row.id);

  try {
    const ciphertext = bytes ?? (await readSourceBytes(row));

    // Guard against copying corrupted bytes: the stored hash is the contract
    if (row.blob.ciphertextHash) {
      const actual = createHash("sha256").update(ciphertext).digest("hex");
      if (actual !== row.blob.ciphertextHash) {
        throw new Error(`source ciphertext hash mismatch for ${row.blobId}`);
      }
    }

    const pool = getPoolFor(row.provider, row.poolRole as PoolRole);

    // A re-upload flips ACTIVE→PENDING while old coordinates remain — drop the
    // stale copy first so providers don't accumulate orphaned messages.
    // (LOCAL needs no cleanup: its put overwrites the same deterministic path.)
    if (row.messageId) {
      await pool
        .delete(placementFromRow(row.blobId, row.blob.ownerUserId, row))
        .catch(() => {});
    }

    const written = await pool.put(row.blob.ownerUserId, row.blobId, ciphertext);

    const updated = await db.blobPlacement.updateMany({
      // Status recheck: if the blob was purged (row gone) or re-queued
      // meanwhile, don't resurrect it as ACTIVE.
      where: { id: row.id, status: { in: ["PENDING", "MISSING"] } },
      data: {
        status: "ACTIVE",
        storagePath: written.storagePath,
        messageId: written.messageId,
        locationId: written.locationId,
        senderId: written.senderId,
        activatedAt: new Date(),
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
      },
    });

    if (updated.count === 0) {
      // Row disappeared (purge won the race) — remove the copy we just wrote
      await pool
        .delete({
          blobId: row.blobId,
          ownerUserId: row.blob.ownerUserId,
          provider: written.provider,
          storagePath: written.storagePath,
          messageId: written.messageId,
          locationId: written.locationId,
          senderId: written.senderId,
        })
        .catch(() => {});
      log({ type: "placement_orphan_cleaned", blobId: row.blobId, provider: row.provider });
      return false;
    }

    // Healing a PRIMARY placement must refresh the legacy mirror columns too
    if (row.poolRole === "PRIMARY") {
      await db.blobTransport.update({
        where: { blobId: row.blobId },
        data: {
          storageKind: written.provider,
          storagePath: written.storagePath,
          discordMessageId: written.provider === "DISCORD" ? written.messageId : null,
          discordChannelId: written.provider === "DISCORD" ? written.locationId : null,
          webhookId: written.provider === "DISCORD" ? written.senderId : null,
          healthStatus: null,
          healthCheckedAt: null,
        },
      }).catch(() => {});
    }

    log({
      type: "placement_replicated",
      blobId: row.blobId,
      provider: row.provider,
      poolRole: row.poolRole,
      viaWriteThrough: bytes !== undefined,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.blobPlacement
      .updateMany({
        where: { id: row.id },
        data: {
          attemptCount: { increment: 1 },
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attemptCount + 1)),
        },
      })
      .catch(() => {});
    log({ type: "placement_replication_failed", blobId: row.blobId, provider: row.provider, error: message });
    return false;
  } finally {
    inFlight.delete(row.id);
  }
}

/** One queue sweep. Returns how many placements were activated. */
export async function runReplicationSweep(): Promise<number> {
  const due = (await db.blobPlacement.findMany({
    where: {
      status: { in: ["PENDING", "MISSING"] },
      attemptCount: { lt: MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH_SIZE,
    include: { blob: true },
  })) as unknown as WorkRow[];

  if (due.length === 0) return 0;

  let activated = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(replicationConcurrency(), due.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= due.length) return;
      if (await processPlacement(due[index]!)) activated++;
    }
  });
  await Promise.all(workers);
  return activated;
}

/**
 * Upload write-through: replicate a blob's queued placements immediately,
 * while its ciphertext is still in memory. Fire-and-forget from the upload
 * path; any failure is retried later by the sweep.
 */
export async function writeThroughReplication(blobId: string, bytes: Uint8Array): Promise<void> {
  const rows = (await db.blobPlacement.findMany({
    where: { blobId, poolRole: "REPLICA", status: "PENDING" },
    include: { blob: true },
  })) as unknown as WorkRow[];

  for (const row of rows) {
    await processPlacement(row, bytes);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

export function startReplicationWorker(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return;
  const kinds = getConfiguredReplicaKinds();
  log({ type: "worker_started", replicaProviders: kinds, intervalMs });
  sweepTimer = setInterval(async () => {
    if (sweeping) return; // don't stack sweeps when a provider is slow
    sweeping = true;
    try {
      await runReplicationSweep();
    } catch (error) {
      log({ type: "sweep_failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      sweeping = false;
    }
  }, intervalMs);
  sweepTimer.unref();
}

export function stopReplicationWorker(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    log({ type: "worker_stopped" });
  }
}
