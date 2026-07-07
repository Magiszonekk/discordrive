// DiscorDrive v4 — Blob transport handlers (secure files v2)

import { db } from "@ddv4/database";
import type { BlobTransportMetadataDto } from "@ddv4/types/api";
import { sha256Ciphertext } from "../storage/local-blobs.js";
import {
  getPoolFor,
  getPrimaryPool,
  orderPlacementsForRead,
  placementFromBlobRecord,
  placementFromRow,
  type PlacementRow,
  type PoolRole,
} from "../storage/provider.js";
import { getConfiguredReplicaKinds } from "../storage/replica-pools.js";
import { writeThroughReplication } from "../storage/replication-worker.js";
import { extractToken, verifySessionToken } from "../middleware/auth.js";
import { constantTimeEqual } from "@ddv4/processing";

type BlobRecord = {
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId?: string | null;
  discordChannelId?: string | null;
  webhookId?: string | null;
  ciphertextSizeBytes: bigint;
  ciphertextHash: string | null;
  healthStatus: string | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
  /** Loaded via include; absent on un-backfilled rows and in legacy callers. */
  placements?: PlacementRow[];
};

async function parseAuth(req: Request): Promise<{ userId: string; email: string } | null> {
  const token = extractToken(req);
  if (!token) return null;

  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}

function normalizeBlobUploadBody(body: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function toMetadataDto(blob: BlobRecord): BlobTransportMetadataDto {
  const base: BlobTransportMetadataDto = {
    blobId: blob.blobId,
    ownerUserId: blob.ownerUserId,
    storageKind: blob.storageKind as BlobTransportMetadataDto["storageKind"],
    storagePath: blob.storagePath,
    ciphertextSizeBytes: blob.ciphertextSizeBytes.toString(),
    ciphertextHash: blob.ciphertextHash ?? undefined,
    healthStatus: blob.healthStatus as BlobTransportMetadataDto["healthStatus"],
    healthCheckedAt: blob.healthCheckedAt?.toISOString(),
    createdAt: blob.createdAt.toISOString(),
  };

  if (blob.storageKind === "DISCORD") {
    base.discordMessageId = blob.discordMessageId ?? undefined;
    base.discordChannelId = blob.discordChannelId ?? undefined;
    base.webhookId = blob.webhookId ?? undefined;
  }

  return base;
}

function looksLikeMissing(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("not found") || msg.includes("404") || msg.includes("enoent");
}

export async function readBlobBytes(blob: BlobRecord): Promise<Uint8Array> {
  // Placements are authoritative; legacy BlobTransport columns cover rows
  // that predate the placement backfill. Candidates are tried in order
  // (ACTIVE PRIMARY → ACTIVE REPLICA → ...) so a dead copy fails over to the
  // next one instead of failing the request.
  const candidates = orderPlacementsForRead(blob.placements ?? []);
  let lastError: unknown = null;

  for (const placement of candidates) {
    try {
      return await getPoolFor(placement.provider, placement.poolRole as PoolRole).get(
        placementFromRow(blob.blobId, blob.ownerUserId, placement),
      );
    } catch (error) {
      lastError = error;
      // Self-heal: park definitively-missing copies as MISSING — the
      // replication worker rebuilds them from a surviving copy. Transient
      // errors (5xx, timeouts) are not marked; the next candidate just serves.
      if (placement.id && looksLikeMissing(error)) {
        void db.blobPlacement
          .updateMany({
            where: { id: placement.id, status: { in: ["ACTIVE", "MODIFIED"] } },
            data: { status: "MISSING", healthCheckedAt: new Date(), attemptCount: 0, nextAttemptAt: null },
          })
          .catch(() => {});
      }
    }
  }

  if (candidates.length > 0) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return getPoolFor(blob.storageKind).get(placementFromBlobRecord(blob));
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function internalErrorResponse(error: unknown): Response {
  return Response.json({ error: asErrorMessage(error) }, { status: 500 });
}

function parseUploadTelemetryHeaders(req: Request): {
  uploadId: string | null;
  chunkIndex: string | null;
  chunkCount: string | null;
  clientTimestamp: string | null;
} {
  return {
    uploadId: req.headers.get("x-upload-id"),
    chunkIndex: req.headers.get("x-chunk-index"),
    chunkCount: req.headers.get("x-chunk-count"),
    clientTimestamp: req.headers.get("x-client-timestamp"),
  };
}

function logBlobUploadEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "blob-upload-debug",
    ...event,
  }));
}

function makeUploadRequestId(blobId: string, telemetry: ReturnType<typeof parseUploadTelemetryHeaders>): string {
  return [blobId, telemetry.uploadId ?? 'noupload', telemetry.chunkIndex ?? 'nochunk', Date.now().toString(36)].join(':');
}

export async function handleBlobMetadata(req: Request, params: { blobId: string }): Promise<Response> {
  const auth = await parseAuth(req);
  if (!auth) return Response.json({ error: "Authentication required" }, { status: 401 });

  const blob = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
  if (!blob || blob.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  return Response.json(toMetadataDto(blob as BlobRecord));
}

export async function handleBlobContent(req: Request, params: { blobId: string }): Promise<Response> {
  const auth = await parseAuth(req);
  if (!auth) return Response.json({ error: "Authentication required" }, { status: 401 });

  const blob = await db.blobTransport.findUnique({
    where: { blobId: params.blobId },
    include: { placements: true },
  });
  if (!blob || blob.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  try {
    const ciphertext = await readBlobBytes(blob as BlobRecord);
    const body = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": ciphertext.byteLength.toString(),
      },
    });
  } catch (error) {
    return internalErrorResponse(error);
  }
}

export async function handleBlobContentForShare(req: Request, params: { blobId: string }): Promise<Response> {
  const shareId = req.headers.get("x-share-id");
  const capabilityToken = req.headers.get("x-capability-token");
  if (!shareId || !capabilityToken) {
    return Response.json({ error: "Share credentials required" }, { status: 401 });
  }

  const share = await db.share.findUnique({
    where: { shareId },
    include: { wrappedObjectKeys: true },
  });
  if (!share) {
    return Response.json({ error: "Share not found" }, { status: 404 });
  }
  if (share.status === "REVOKED") {
    return Response.json({ error: "Share revoked" }, { status: 410 });
  }
  if (share.status !== "ACTIVE") {
    return Response.json({ error: "Share not active" }, { status: 404 });
  }
  if (share.expiresAt && share.expiresAt < new Date()) {
    return Response.json({ error: "Share expired" }, { status: 410 });
  }
  if (share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews) {
    return Response.json({ error: "Share view limit reached" }, { status: 410 });
  }

  const matches = await constantTimeEqual(
    new Uint8Array(share.capabilityToken),
    Uint8Array.from(Buffer.from(capabilityToken, "base64")),
  );
  if (!matches) {
    return Response.json({ error: "Invalid capability token" }, { status: 403 });
  }

  const blob = await db.blobTransport.findUnique({
    where: { blobId: params.blobId },
    include: { placements: true },
  });
  if (!blob) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  // Secure-files share download needs access to the manifest blob and its chunk blobs.
  // The server cannot decrypt the manifest, so it cannot enumerate chunk membership here.
  // We therefore scope access to blobs owned by the same owner as the validated share.
  // Blob IDs are client-presented opaque identifiers; possession still requires the share capability token.
  if (blob.ownerUserId !== share.ownerUserId) {
    return Response.json({ error: "Blob not accessible via this share" }, { status: 403 });
  }

  try {
    const ciphertext = await readBlobBytes(blob as BlobRecord);
    const body = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": ciphertext.byteLength.toString(),
      },
    });
  } catch (error) {
    return internalErrorResponse(error);
  }
}

export async function handleBlobUpload(req: Request, params: { blobId: string }): Promise<Response> {
  const auth = await parseAuth(req);
  if (!auth) return Response.json({ error: "Authentication required" }, { status: 401 });

  const telemetry = parseUploadTelemetryHeaders(req);
  const requestId = makeUploadRequestId(params.blobId, telemetry);
  const requestStartMs = performance.now();

  const existing = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
  if (existing && existing.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  try {
    logBlobUploadEvent({
      type: "blob_upload_received",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      contentLength: req.headers.get("content-length"),
    });

    const readBodyStartMs = performance.now();
    const ciphertext = normalizeBlobUploadBody(await req.arrayBuffer());
    const readBodyMs = performance.now() - readBodyStartMs;

    const ciphertextSizeBytes = BigInt(ciphertext.byteLength);

    const hashStartMs = performance.now();
    const ciphertextHash = sha256Ciphertext(ciphertext);
    const hashMs = performance.now() - hashStartMs;

    const pool = getPrimaryPool();
    const storageKind = pool.kind;

    const storeStartMs = performance.now();
    const written = await pool.put(auth.userId, params.blobId, ciphertext, {
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
    });
    const storeMs = performance.now() - storeStartMs;

    const storagePath = written.storagePath;
    const discordMessageId = written.messageId;
    const discordChannelId = written.locationId;
    const webhookId = written.senderId;

    // Persist transport coordinates immediately so interrupted uploads can be
    // resumed: without this, chunks already stored (e.g. on Discord) would be
    // unrecoverable orphans until commitManifest. Re-uploads of the same blobId
    // overwrite the record with the newest location.
    const transportData = {
      ownerUserId: auth.userId,
      storageKind,
      storagePath,
      ...(storageKind === "DISCORD" ? { discordMessageId, discordChannelId, webhookId } : {}),
      ciphertextSizeBytes,
      ciphertextHash,
    };
    const placementCoordinates = {
      status: "ACTIVE" as const,
      storagePath,
      messageId: discordMessageId,
      locationId: discordChannelId,
      senderId: webhookId,
      activatedAt: new Date(),
    };
    const replicaKinds = getConfiguredReplicaKinds();
    await db.$transaction([
      db.blobTransport.upsert({
        where: { blobId: params.blobId },
        create: { blobId: params.blobId, ...transportData },
        update: { ...transportData, healthStatus: null, healthCheckedAt: null },
      }),
      // A re-upload may land on a different provider; stale PRIMARY placements
      // of other providers must not survive it.
      db.blobPlacement.deleteMany({
        where: { blobId: params.blobId, poolRole: "PRIMARY", NOT: { provider: storageKind } },
      }),
      db.blobPlacement.upsert({
        where: {
          blobId_provider_poolRole: {
            blobId: params.blobId,
            provider: storageKind,
            poolRole: "PRIMARY",
          },
        },
        create: {
          blobId: params.blobId,
          provider: storageKind,
          poolRole: "PRIMARY",
          ...placementCoordinates,
        },
        update: { ...placementCoordinates, attemptCount: 0, lastError: null },
      }),
      ...(replicaKinds.length > 0
        ? [
            // Re-upload changed the bytes — existing replica copies are stale
            // and must be re-replicated.
            db.blobPlacement.updateMany({
              where: {
                blobId: params.blobId,
                poolRole: "REPLICA",
                status: { in: ["ACTIVE", "MISSING", "MODIFIED"] },
              },
              data: { status: "PENDING", attemptCount: 0, nextAttemptAt: null },
            }),
            db.blobPlacement.createMany({
              skipDuplicates: true,
              data: replicaKinds.map((kind) => ({
                blobId: params.blobId,
                provider: kind,
                poolRole: "REPLICA" as const,
                status: "PENDING" as const,
                storagePath: "pending://replica",
              })),
            }),
          ]
        : []),
    ]);

    if (replicaKinds.length > 0) {
      // Opportunistic write-through: copy to replica pools now, while the
      // ciphertext is in memory. Never blocks the response; the durable
      // PENDING rows are the fallback if this fails or the process dies.
      void writeThroughReplication(params.blobId, ciphertext).catch((error) => {
        logBlobUploadEvent({
          type: "write_through_failed",
          requestId,
          blobId: params.blobId,
          error: asErrorMessage(error),
        });
      });
    }

    logBlobUploadEvent({
      type: "blob_upload_completed",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      storageKind,
      webhookId,
      uploadTransportPath: written.diagnostics?.uploadTransportPath ?? null,
      uploadAttemptCount: written.diagnostics?.uploadAttemptCount ?? null,
      uploadUpstreamStatus: written.diagnostics?.uploadUpstreamStatus ?? null,
      uploadElapsedMs: written.diagnostics?.uploadElapsedMs ?? null,
      relayEgress: written.diagnostics?.relayEgress ?? null,
      limiterRemaining: written.diagnostics?.limiterRemaining ?? null,
      limiterInFlight: written.diagnostics?.limiterInFlight ?? null,
      ciphertextSizeBytes: ciphertext.byteLength,
      readBodyMs: Number(readBodyMs.toFixed(2)),
      hashMs: Number(hashMs.toFixed(2)),
      storeMs: Number(storeMs.toFixed(2)),
      totalMs: Number((performance.now() - requestStartMs).toFixed(2)),
    });

    return Response.json({
      blobId: params.blobId,
      ciphertextSizeBytes: ciphertextSizeBytes.toString(),
      ciphertextHash,
      storageKind,
      storagePath,
      discordMessageId: discordMessageId ?? undefined,
      discordChannelId: discordChannelId ?? undefined,
      webhookId: webhookId ?? undefined,
    });
  } catch (error) {
    logBlobUploadEvent({
      type: "blob_upload_failed",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      totalMs: Number((performance.now() - requestStartMs).toFixed(2)),
      error: asErrorMessage(error),
    });
    return internalErrorResponse(error);
  }
}
