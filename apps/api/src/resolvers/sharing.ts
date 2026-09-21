// DiscorDrive v4 — Share resolvers (secure files v2)

import { db } from "@ddv4/database";
import type { CreateFileShareRequest, ShareAccessResponse } from "@ddv4/types/api";
import { constantTimeEqual } from "@ddv4/processing";

function decodeToken(token: string): Uint8Array {
  return Uint8Array.from(Buffer.from(token, "base64"));
}

export async function createShare(
  ownerUserId: string,
  input: CreateFileShareRequest,
): Promise<{ shareId: string }> {
  const file = await db.file.findFirst({
    where: { id: input.fileId, ownerUserId, deletedAt: null, status: "READY" },
  });
  if (!file) throw new Error("File not found or not ready");

  const share = await db.share.create({
    data: {
      ownerUserId,
      shareType: "FILE",
      capabilityToken: Buffer.from(input.capabilityToken, "base64"),
      allowContent: input.allowContent,
      allowMetadata: input.allowMetadata ?? false,
      allowPreview: input.allowPreview ?? false,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      maxViews: input.maxViews ?? null,
      grantedAccess: {
        create: {
          accessType: "PUBLIC_LINK",
          wrappedAKShare: Buffer.from(input.wrappedAKShare, "base64"),
        },
      },
      wrappedObjectKeys: {
        create: {
          fileId: input.fileId,
          wrappedFEK: input.wrappedFEK ? Buffer.from(input.wrappedFEK, "base64") : null,
          wrappedFEKPreview: input.wrappedFEKPreview ? Buffer.from(input.wrappedFEKPreview, "base64") : null,
        },
      },
    },
  });

  return { shareId: share.shareId };
}

export async function revokeShare(ownerUserId: string, shareId: string): Promise<boolean> {
  const share = await db.share.findFirst({ where: { shareId, ownerUserId } });
  if (!share) throw new Error("Share not found");

  await db.share.update({
    where: { shareId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return true;
}

export async function getShares(ownerUserId: string, fileId: string) {
  return db.share.findMany({
    where: { ownerUserId, wrappedObjectKeys: { some: { fileId } } },
    orderBy: { createdAt: "desc" },
    include: { wrappedObjectKeys: true, grantedAccess: true },
  });
}

export async function accessShare(
  shareId: string,
  presentedCapabilityToken: string,
): Promise<ShareAccessResponse | null> {
  const share = await db.share.findUnique({
    where: { shareId },
    include: { wrappedObjectKeys: { include: { file: true } }, grantedAccess: true },
  });

  if (!share) return null;
  if (share.status !== "ACTIVE") return null;
  if (share.expiresAt && share.expiresAt < new Date()) return null;
  if (share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews) return null;

  const matches = await constantTimeEqual(
    new Uint8Array(share.capabilityToken),
    decodeToken(presentedCapabilityToken),
  );
  if (!matches) return null;

  await db.share.update({
    where: { shareId },
    data: { viewCount: { increment: 1 } },
  });

  const grantedAccess = share.grantedAccess[0];
  if (!grantedAccess) return null;

  return {
    shareId: share.shareId,
    wrappedAKShare: Buffer.from(grantedAccess.wrappedAKShare).toString("base64"),
    wrappedObjectKeys: share.wrappedObjectKeys.map((item) => ({
      fileId: item.fileId,
      primaryManifestBlobId: item.file.primaryManifestBlobId ?? undefined,
      // Permission-gated fields: the server only releases what the owner allowed
      previewBlobId: share.allowPreview ? item.file.previewBlobId ?? undefined : undefined,
      encryptedName: share.allowMetadata ? item.file.encryptedName ?? undefined : undefined,
      encryptedMimeType: share.allowMetadata ? item.file.encryptedMimeType ?? undefined : undefined,
      wrappedFEK: item.wrappedFEK ? Buffer.from(item.wrappedFEK).toString("base64") : undefined,
      wrappedFEKPreview: share.allowPreview && item.wrappedFEKPreview
        ? Buffer.from(item.wrappedFEKPreview).toString("base64")
        : undefined,
      // Not permission-gated: sizes/chunk counts aren't file content, just
      // transport shape the video player needs to size its byte-range requests.
      totalCiphertextBytes: item.file.totalCiphertextBytes.toString(),
      chunkCount: item.file.chunkCount,
    })),
    allowContent: share.allowContent,
    allowMetadata: share.allowMetadata,
    allowPreview: share.allowPreview,
  };
}
