// DiscorDrive v4 — Blob transport handlers (secure files v2)

import { db } from "@ddv4/database";
import type { BlobTransportMetadataDto } from "@ddv4/types/api";
import {
  ensureBlobRootDir,
  readCiphertextBlob,
  sha256Ciphertext,
  writeCiphertextBlob,
} from "../storage/local-blobs.js";
import {
  fetchCiphertextBlobFromDiscord,
  uploadCiphertextBlobToDiscord,
} from "../storage/discord-blobs.js";
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

function getBlobStorageKind(): "LOCAL" | "DISCORD" {
  const configured = process.env.BLOB_STORAGE_KIND?.trim().toUpperCase();
  if (!configured || configured === "LOCAL") return "LOCAL";
  if (configured === "DISCORD") return "DISCORD";
  throw new Error(`Unsupported BLOB_STORAGE_KIND: ${configured}`);
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

export async function readBlobBytes(blob: BlobRecord): Promise<Uint8Array> {
  if (blob.storageKind === "DISCORD") {
    if (!blob.discordMessageId || !blob.webhookId) {
      throw new Error(`Discord blob ${blob.blobId} is missing transport coordinates`);
    }
    return fetchCiphertextBlobFromDiscord(blob.storagePath, blob.discordMessageId, blob.webhookId, blob.discordChannelId);
  }

  return readCiphertextBlob(blob.ownerUserId, blob.blobId);
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

  const blob = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
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

  const blob = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
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

    const storageKind = getBlobStorageKind();

    let storagePath: string;
    let discordMessageId: string | null = null;
    let discordChannelId: string | null = null;
    let webhookId: string | null = null;

    const storeStartMs = performance.now();
    let uploadTransportPath: "direct" | "relay" | "bot" | null = null;
    let uploadAttemptCount: number | null = null;
    let uploadUpstreamStatus: number | null = null;
    let uploadElapsedMs: number | null = null;
    let relayEgress: string | null = null;
    let discordUploadLimiterRemaining: number | null = null;
    let discordUploadLimiterInFlight: number | null = null;

    if (storageKind === "DISCORD") {
      const discordUpload = await uploadCiphertextBlobToDiscord(auth.userId, params.blobId, ciphertext, {
        requestId,
        uploadId: telemetry.uploadId,
        chunkIndex: telemetry.chunkIndex,
        chunkCount: telemetry.chunkCount,
      });
      storagePath = discordUpload.storagePath;
      discordMessageId = discordUpload.discordMessageId;
      discordChannelId = discordUpload.discordChannelId;
      webhookId = discordUpload.webhookId;
      uploadTransportPath = discordUpload.transportPath;
      uploadAttemptCount = discordUpload.attemptCount;
      uploadUpstreamStatus = discordUpload.upstreamStatus;
      uploadElapsedMs = discordUpload.elapsedMs;
      relayEgress = discordUpload.relayEgress;
      discordUploadLimiterRemaining = discordUpload.limiterRemaining;
      discordUploadLimiterInFlight = discordUpload.limiterInFlight;
    } else {
      await ensureBlobRootDir();
      storagePath = await writeCiphertextBlob(auth.userId, params.blobId, ciphertext);
    }
    const storeMs = performance.now() - storeStartMs;

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
    await db.blobTransport.upsert({
      where: { blobId: params.blobId },
      create: { blobId: params.blobId, ...transportData },
      update: { ...transportData, healthStatus: null, healthCheckedAt: null },
    });

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
      uploadTransportPath,
      uploadAttemptCount,
      uploadUpstreamStatus,
      uploadElapsedMs,
      relayEgress,
      limiterRemaining: storageKind === "DISCORD" ? discordUploadLimiterRemaining : null,
      limiterInFlight: storageKind === "DISCORD" ? discordUploadLimiterInFlight : null,
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
