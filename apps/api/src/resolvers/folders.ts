// DiscorDrive v4 — Folder resolvers (secure files v2)

import { db } from "@ddv4/database";

export async function createFolder(
  ownerUserId: string,
  encryptedBodyB64: string,
  wrappedFolderKeyB64: string,
  parentFolderId: string | null,
) {
  if (parentFolderId) {
    const parent = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!parent) throw new Error("Parent folder not found");
  }

  return db.folder.create({
    data: {
      ownerUserId,
      parentFolderId,
      encryptedBody: Buffer.from(encryptedBodyB64, "base64"),
      wrappedFolderKey: Buffer.from(wrappedFolderKeyB64, "base64"),
      itemCount: 0,
    },
  });
}

export async function deleteFolder(ownerUserId: string, folderId: string): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, ownerUserId } });
  if (!folder) throw new Error("Folder not found");

  const [childCount, fileCount] = await Promise.all([
    db.folder.count({ where: { parentFolderId: folderId } }),
    db.file.count({ where: { parentFolderId: folderId, deletedAt: null } }),
  ]);

  if (childCount > 0 || fileCount > 0) throw new Error("Folder is not empty");
  await db.folder.delete({ where: { id: folderId } });
  return true;
}

export async function getFolders(ownerUserId: string, parentFolderId: string | null) {
  return db.folder.findMany({
    where: { ownerUserId, parentFolderId },
    orderBy: { createdAt: "asc" },
  });
}
