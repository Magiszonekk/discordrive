// DiscorDrive v4 — Folder resolvers

import { db } from "@ddv4/database";

export async function createFolder(
  userId: string,
  name: string,
  parentId: string | null,
): Promise<{ id: string }> {
  if (parentId) {
    const parent = await db.folder.findFirst({ where: { id: parentId, userId } });
    if (!parent) throw new Error("Parent folder not found");
  }

  const folder = await db.folder.create({
    data: { userId, name, parentId },
  });

  return { id: folder.id };
}

export async function deleteFolder(
  userId: string,
  folderId: string,
): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw new Error("Folder not found");

  // Check if folder has children or files
  const [childCount, fileCount] = await Promise.all([
    db.folder.count({ where: { parentId: folderId } }),
    db.file.count({ where: { folderId } }),
  ]);

  if (childCount > 0 || fileCount > 0) {
    throw new Error("Folder is not empty");
  }

  await db.folder.delete({ where: { id: folderId } });
  return true;
}

export async function renameFolder(
  userId: string,
  folderId: string,
  name: string,
): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw new Error("Folder not found");

  await db.folder.update({
    where: { id: folderId },
    data: { name },
  });

  return true;
}

export async function getFolders(userId: string, parentId: string | null) {
  const folders = await db.folder.findMany({
    where: { userId, parentId },
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: {
          children: true,
          files: true,
        },
      },
    },
  });

  return folders.map((f) => ({
    ...f,
    subfolderCount: f._count.children,
    fileCount: f._count.files,
  }));
}
