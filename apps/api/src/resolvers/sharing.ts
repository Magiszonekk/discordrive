// DiscorDrive v4 — Share link resolvers

import argon2 from "argon2";
import { db } from "@ddv4/database";
import type { CreateShareRequest, ShareInfoResponse } from "@ddv4/types/api";

export async function createShareLink(
  userId: string,
  input: CreateShareRequest,
): Promise<{ token: string }> {
  const file = await db.file.findFirst({
    where: { id: input.fileId, userId, status: "READY" },
  });
  if (!file) throw new Error("File not found or not ready");

  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;

  if (input.password) {
    passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    // Salt is embedded in argon2 hash, but we store separately for client-side derive
    passwordSalt = input.password; // Client handles this
    passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    passwordSalt = null; // Client sends pre-derived wrappedFEK
  }

  const shareLink = await db.shareLink.create({
    data: {
      fileId: input.fileId,
      userId,
      wrappedFEK: input.wrappedFEK,
      wrapIv: input.wrapIv,
      passwordHash,
      passwordSalt,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      label: input.label ?? null,
      maxDownloads: input.maxDownloads ?? null,
    },
  });

  return { token: shareLink.token };
}

export async function deleteShareLink(
  userId: string,
  token: string,
): Promise<boolean> {
  const link = await db.shareLink.findFirst({ where: { token, userId } });
  if (!link) throw new Error("Share link not found");

  await db.shareLink.delete({ where: { token } });
  return true;
}

export async function updateShareLink(
  userId: string,
  token: string,
  updates: { label?: string; maxDownloads?: number | null; expiresAt?: string | null },
): Promise<boolean> {
  const link = await db.shareLink.findFirst({ where: { token, userId } });
  if (!link) throw new Error("Share link not found");

  await db.shareLink.update({
    where: { token },
    data: {
      ...(updates.label !== undefined && { label: updates.label }),
      ...(updates.maxDownloads !== undefined && { maxDownloads: updates.maxDownloads }),
      ...(updates.expiresAt !== undefined && {
        expiresAt: updates.expiresAt ? new Date(updates.expiresAt) : null,
      }),
    },
  });

  return true;
}

export async function getShareLinks(userId: string, fileId: string) {
  return db.shareLink.findMany({
    where: { fileId, userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getShareInfo(token: string): Promise<ShareInfoResponse | null> {
  const link = await db.shareLink.findUnique({
    where: { token },
    include: { file: true },
  });

  if (!link) return null;

  // Check expiry
  if (link.expiresAt && link.expiresAt < new Date()) return null;

  // Check max downloads
  if (link.maxDownloads !== null && link.downloads >= link.maxDownloads) return null;

  return {
    fileName: link.file.name,
    fileSize: link.file.size.toString(),
    mimeType: link.file.mimeType,
    wrappedFEK: link.wrappedFEK,
    wrapIv: link.wrapIv,
    isPasswordProtected: link.passwordHash !== null,
    chunkCount: link.file.chunkCount,
    chunkSize: link.file.chunkSize,
  };
}

export async function verifySharePassword(
  token: string,
  password: string,
): Promise<boolean> {
  const link = await db.shareLink.findUnique({ where: { token } });
  if (!link || !link.passwordHash) return false;

  return argon2.verify(link.passwordHash, password);
}

export async function incrementShareDownloads(token: string): Promise<void> {
  await db.shareLink.update({
    where: { token },
    data: { downloads: { increment: 1 } },
  });
}
