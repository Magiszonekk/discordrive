// DiscorDrive v4 — Blob storage provider abstraction
//
// Every physical copy of a blob lives with exactly one provider (LOCAL disk,
// Discord attachments, ...). A BlobProviderPool bundles one provider's senders
// (webhooks/bots) plus its rate-limiter budget; PRIMARY and REPLICA pools are
// separate instances so replica traffic never shares sender budgets with
// primary traffic.

import { unlink } from "node:fs/promises";
import {
  ensureBlobRootDir,
  readCiphertextBlob,
  statCiphertextBlob,
  writeCiphertextBlob,
} from "./local-blobs.js";
import {
  discordSenderAvailability,
  discordSenderCount,
  fetchCiphertextBlobFromDiscord,
  statDiscordBlob,
  uploadCiphertextBlobToDiscord,
  deleteCiphertextBlobFromDiscord,
} from "./discord-blobs.js";
import {
  deleteCiphertextBlobFromTelegram,
  fetchCiphertextBlobFromTelegram,
  statTelegramBlob,
  telegramSenderAvailability,
  telegramSenderCount,
  uploadCiphertextBlobToTelegram,
} from "./telegram-blobs.js";
import { getReplicaPool } from "./replica-pools.js";

export type ProviderKind = "LOCAL" | "DISCORD" | "TELEGRAM";
export type PoolRole = "PRIMARY" | "REPLICA";

/** Coordinates of one stored copy of a blob — everything a provider needs to find it again. */
export interface PlacementRef {
  blobId: string;
  ownerUserId: string;
  provider: ProviderKind;
  storagePath: string;
  /** discord message id / telegram message_id */
  messageId?: string | null;
  /** discord channel id / telegram chat_id */
  locationId?: string | null;
  /** webhook numeric id, "BOT_n", "TG_BOT_n", ... — selects sender for reads/deletes */
  senderId?: string | null;
}

export interface PlacementWriteResult {
  provider: ProviderKind;
  storagePath: string;
  messageId: string | null;
  locationId: string | null;
  senderId: string | null;
  /** Provider-specific upload diagnostics, forwarded into structured logs. */
  diagnostics?: Record<string, unknown>;
}

export interface BlobUploadTelemetry {
  requestId?: string;
  uploadId?: string | null;
  chunkIndex?: string | null;
  chunkCount?: string | null;
}

export interface BlobProviderPool {
  readonly kind: ProviderKind;
  readonly role: PoolRole;
  put(
    ownerUserId: string,
    blobId: string,
    bytes: Uint8Array,
    telemetry?: BlobUploadTelemetry,
  ): Promise<PlacementWriteResult>;
  get(placement: PlacementRef): Promise<Uint8Array>;
  stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }>;
  delete(placement: PlacementRef): Promise<void>;
  /** Configured senders in this pool (0 = provider unusable). */
  senderCount(): number;
  /** Senders usable right now — striping sends each chunk to the pool with the most free budget. */
  availability(): number;
}

// ---------------------------------------------------------------------------
// LOCAL
// ---------------------------------------------------------------------------

class LocalBlobPool implements BlobProviderPool {
  readonly kind = "LOCAL" as const;
  constructor(readonly role: PoolRole) {}

  async put(ownerUserId: string, blobId: string, bytes: Uint8Array): Promise<PlacementWriteResult> {
    await ensureBlobRootDir();
    const storagePath = await writeCiphertextBlob(ownerUserId, blobId, bytes);
    return { provider: this.kind, storagePath, messageId: null, locationId: null, senderId: null };
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    return readCiphertextBlob(placement.ownerUserId, placement.blobId);
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    try {
      const s = await statCiphertextBlob(placement.ownerUserId, placement.blobId);
      return { exists: true, size: s.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }

  async delete(placement: PlacementRef): Promise<void> {
    await unlink(placement.storagePath);
  }

  senderCount(): number {
    return 1;
  }

  availability(): number {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// DISCORD
// ---------------------------------------------------------------------------

class DiscordBlobPool implements BlobProviderPool {
  readonly kind = "DISCORD" as const;
  constructor(readonly role: PoolRole) {}

  async put(
    ownerUserId: string,
    blobId: string,
    bytes: Uint8Array,
    telemetry?: BlobUploadTelemetry,
  ): Promise<PlacementWriteResult> {
    const upload = await uploadCiphertextBlobToDiscord(ownerUserId, blobId, bytes, telemetry);
    return {
      provider: this.kind,
      storagePath: upload.storagePath,
      messageId: upload.discordMessageId,
      locationId: upload.discordChannelId,
      senderId: upload.webhookId,
      diagnostics: {
        uploadTransportPath: upload.transportPath,
        uploadAttemptCount: upload.attemptCount,
        uploadUpstreamStatus: upload.upstreamStatus,
        uploadElapsedMs: upload.elapsedMs,
        relayEgress: upload.relayEgress,
        limiterRemaining: upload.limiterRemaining,
        limiterInFlight: upload.limiterInFlight,
      },
    };
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    if (!placement.messageId || !placement.senderId) {
      throw new Error(`Discord blob ${placement.blobId} is missing transport coordinates`);
    }
    return fetchCiphertextBlobFromDiscord(
      placement.storagePath,
      placement.messageId,
      placement.senderId,
      placement.locationId,
    );
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    return statDiscordBlob(placement.storagePath);
  }

  async delete(placement: PlacementRef): Promise<void> {
    if (!placement.messageId || !placement.senderId) return;
    await deleteCiphertextBlobFromDiscord(placement.messageId, placement.senderId, placement.locationId);
  }

  senderCount(): number {
    return discordSenderCount();
  }

  availability(): number {
    return discordSenderAvailability();
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------

class TelegramBlobPool implements BlobProviderPool {
  readonly kind = "TELEGRAM" as const;
  constructor(readonly role: PoolRole) {}

  async put(ownerUserId: string, blobId: string, bytes: Uint8Array): Promise<PlacementWriteResult> {
    const upload = await uploadCiphertextBlobToTelegram(ownerUserId, blobId, bytes);
    return {
      provider: this.kind,
      storagePath: upload.storagePath,
      messageId: upload.messageId,
      locationId: upload.chatId,
      senderId: upload.senderId,
      diagnostics: {
        uploadTransportPath: "telegram-bot",
        uploadAttemptCount: upload.attemptCount,
        uploadUpstreamStatus: upload.upstreamStatus,
        uploadElapsedMs: upload.elapsedMs,
      },
    };
  }

  async get(placement: PlacementRef): Promise<Uint8Array> {
    if (!placement.senderId) {
      throw new Error(`Telegram blob ${placement.blobId} is missing transport coordinates`);
    }
    return fetchCiphertextBlobFromTelegram(placement.storagePath, placement.senderId);
  }

  async stat(placement: PlacementRef): Promise<{ exists: boolean; size: number }> {
    return statTelegramBlob(placement.storagePath);
  }

  async delete(placement: PlacementRef): Promise<void> {
    if (!placement.messageId || !placement.senderId) return;
    await deleteCiphertextBlobFromTelegram(placement.messageId, placement.senderId, placement.locationId);
  }

  senderCount(): number {
    return telegramSenderCount();
  }

  availability(): number {
    return telegramSenderAvailability();
  }
}

// ---------------------------------------------------------------------------
// Pool registry
// ---------------------------------------------------------------------------

const primaryPools = new Map<ProviderKind, BlobProviderPool>([
  ["LOCAL", new LocalBlobPool("PRIMARY")],
  ["DISCORD", new DiscordBlobPool("PRIMARY")],
  ["TELEGRAM", new TelegramBlobPool("PRIMARY")],
]);

/**
 * Pool used for reads/deletes of an existing placement. REPLICA placements
 * must resolve to the replica pool — their senders (webhooks/bots/accounts)
 * are disjoint from the primary pool's.
 */
export function getPoolFor(kind: string, role: PoolRole = "PRIMARY"): BlobProviderPool {
  if (role === "REPLICA") return getReplicaPool(kind);
  const pool = primaryPools.get(kind as ProviderKind);
  if (!pool) throw new Error(`Unsupported blob storage kind: ${kind}`);
  return pool;
}

/**
 * Providers eligible for new uploads. STORAGE_PRIMARY_PROVIDERS (comma list,
 * e.g. "DISCORD,TELEGRAM") enables striping; BLOB_STORAGE_KIND is the
 * single-provider fallback for instances that never set the list.
 */
function getPrimaryProviderKinds(): ProviderKind[] {
  const list = process.env.STORAGE_PRIMARY_PROVIDERS?.trim();
  if (list) {
    return list.split(",").map((entry) => {
      const kind = entry.trim().toUpperCase();
      if (!primaryPools.has(kind as ProviderKind)) {
        throw new Error(`Unsupported storage provider in STORAGE_PRIMARY_PROVIDERS: ${entry.trim()}`);
      }
      return kind as ProviderKind;
    });
  }

  const configured = process.env.BLOB_STORAGE_KIND?.trim().toUpperCase();
  if (!configured || configured === "LOCAL") return ["LOCAL"];
  if (configured === "DISCORD") return ["DISCORD"];
  if (configured === "TELEGRAM") return ["TELEGRAM"];
  throw new Error(`Unsupported BLOB_STORAGE_KIND: ${configured}`);
}

let uploadPoolRoundRobin = 0;

/**
 * Pool that receives the next upload. With one configured provider this is
 * static; with several, each chunk goes to the pool with the most currently
 * available senders (freest rate-limit budget), so a saturated or 429-blocked
 * provider naturally sheds load to the others. Ties rotate round-robin.
 */
export function getPrimaryPool(): BlobProviderPool {
  const kinds = getPrimaryProviderKinds();
  if (kinds.length === 1) return primaryPools.get(kinds[0]!)!;

  const pools = kinds.map((kind) => primaryPools.get(kind)!).filter((pool) => pool.senderCount() > 0);
  if (pools.length === 0) {
    throw new Error("No primary storage provider has configured senders");
  }

  let best = pools[0]!;
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < pools.length; i++) {
    const idx = (uploadPoolRoundRobin + i) % pools.length;
    const score = pools[idx]!.availability();
    if (score > bestScore) {
      bestScore = score;
      best = pools[idx]!;
      bestIdx = idx;
    }
  }
  uploadPoolRoundRobin = (bestIdx + 1) % pools.length;
  return best;
}

/** Shape of a BlobPlacement DB row as consumed by read/delete paths. */
export interface PlacementRow {
  /** DB row id — present on real rows, used to persist status transitions. */
  id?: string;
  provider: string;
  poolRole: string;
  status: string;
  storagePath: string;
  messageId?: string | null;
  locationId?: string | null;
  senderId?: string | null;
}

/**
 * Ordered read candidates: ACTIVE PRIMARY first, then ACTIVE REPLICA.
 * MODIFIED placements are last-resort candidates (bytes may still decrypt
 * client-side if the mismatch is a hash-recording artifact); PENDING and
 * DELETING never serve reads (no/going-away physical copy).
 */
export function orderPlacementsForRead<T extends PlacementRow>(rows: T[]): T[] {
  const score = (r: PlacementRow): number => {
    const roleBonus = r.poolRole === "PRIMARY" ? 0 : 1;
    if (r.status === "ACTIVE") return 0 + roleBonus;
    if (r.status === "MODIFIED") return 4 + roleBonus;
    return Number.POSITIVE_INFINITY;
  };
  return rows
    .filter((r) => Number.isFinite(score(r)))
    .sort((a, b) => score(a) - score(b));
}

/** Builds a PlacementRef from a BlobPlacement row plus its blob's identity. */
export function placementFromRow(
  blobId: string,
  ownerUserId: string,
  row: PlacementRow,
): PlacementRef {
  return {
    blobId,
    ownerUserId,
    provider: row.provider as ProviderKind,
    storagePath: row.storagePath,
    messageId: row.messageId ?? null,
    locationId: row.locationId ?? null,
    senderId: row.senderId ?? null,
  };
}

/** Builds a PlacementRef from a BlobTransport-shaped record (legacy columns). */
export function placementFromBlobRecord(blob: {
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId?: string | null;
  discordChannelId?: string | null;
  webhookId?: string | null;
}): PlacementRef {
  return {
    blobId: blob.blobId,
    ownerUserId: blob.ownerUserId,
    provider: blob.storageKind as ProviderKind,
    storagePath: blob.storagePath,
    messageId: blob.discordMessageId ?? null,
    locationId: blob.discordChannelId ?? null,
    senderId: blob.webhookId ?? null,
  };
}
