// DiscorDrive v4 — Folder resolvers (secure files v2)

import { db, Prisma } from "@ddv4/database";

// Enriched folder type with computed stats
interface FolderWithStats {
  id: string;
  ownerUserId: string;
  parentFolderId: string | null;
  encryptedBody: Buffer;
  wrappedFolderKey: Buffer;
  itemCount: number;
  totalSizeBytes: string;
  createdAt: Date;
  updatedAt: Date;
}

// Computes itemCount (direct children) and totalSizeBytes (recursive sum) for
// a list of folder IDs in two batched queries instead of N per-folder queries.
async function enrichFolders(
  ownerUserId: string,
  folders: Awaited<ReturnType<typeof db.folder.findMany>>,
): Promise<FolderWithStats[]> {
  if (folders.length === 0) return [];

  const ids = folders.map((f) => f.id);

  // --- Direct item counts (files + subfolders) ---
  const [fileCounts, subfolderCounts] = await Promise.all([
    db.file.groupBy({
      by: ["parentFolderId"],
      where: { parentFolderId: { in: ids }, ownerUserId, deletedAt: null },
      _count: { _all: true },
    }),
    db.folder.groupBy({
      by: ["parentFolderId"],
      where: { parentFolderId: { in: ids }, ownerUserId },
      _count: { _all: true },
    }),
  ]);

  const fileCountMap = new Map(fileCounts.map((r) => [r.parentFolderId, r._count._all]));
  const subfolderCountMap = new Map(subfolderCounts.map((r) => [r.parentFolderId, r._count._all]));

  // --- Recursive total size via CTE (single query for all folders) ---
  const sizeRows = await db.$queryRaw<Array<{ root_id: string; total: bigint }>>`
    WITH RECURSIVE folder_tree AS (
      SELECT id, id AS root_id
      FROM "Folder"
      WHERE id IN (${Prisma.join(ids)})
        AND "ownerUserId" = ${ownerUserId}
      UNION ALL
      SELECT f.id, ft.root_id
      FROM "Folder" f
      JOIN folder_tree ft ON f."parentFolderId" = ft.id
      WHERE f."ownerUserId" = ${ownerUserId}
    )
    SELECT ft.root_id,
           COALESCE(SUM(fi."totalCiphertextBytes"), 0)::bigint AS total
    FROM folder_tree ft
    LEFT JOIN "File" fi
           ON fi."parentFolderId" = ft.id
          AND fi."ownerUserId" = ${ownerUserId}
          AND fi."deletedAt" IS NULL
          AND fi.status = 'READY'::"FileStatus"
    GROUP BY ft.root_id
  `;

  const sizeMap = new Map(sizeRows.map((r) => [r.root_id, r.total.toString()]));

  return folders.map((f) => ({
    ...f,
    encryptedBody: Buffer.from(f.encryptedBody),
    wrappedFolderKey: Buffer.from(f.wrappedFolderKey),
    itemCount: (fileCountMap.get(f.id) ?? 0) + (subfolderCountMap.get(f.id) ?? 0),
    totalSizeBytes: sizeMap.get(f.id) ?? "0",
  }));
}

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

  const folder = await db.folder.create({
    data: {
      ownerUserId,
      parentFolderId,
      encryptedBody: Buffer.from(encryptedBodyB64, "base64"),
      wrappedFolderKey: Buffer.from(wrappedFolderKeyB64, "base64"),
      itemCount: 0,
    },
  });

  const [enriched] = await enrichFolders(ownerUserId, [folder]);
  return enriched!;
}

export async function renameFolder(
  ownerUserId: string,
  folderId: string,
  encryptedBodyB64: string,
): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, ownerUserId } });
  if (!folder) throw new Error("Folder not found");
  await db.folder.update({
    where: { id: folderId },
    data: { encryptedBody: Buffer.from(encryptedBodyB64, "base64") },
  });
  return true;
}

export async function moveFolder(
  ownerUserId: string,
  folderId: string,
  parentFolderId: string | null,
): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, ownerUserId } });
  if (!folder) throw new Error("Folder not found");
  if (parentFolderId === folderId) throw new Error("Cannot move folder into itself");

  if (parentFolderId) {
    const parent = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!parent) throw new Error("Target folder not found");

    // Reject moving a folder into its own descendant — would create a cycle
    // (and hang the recursive size CTE in enrichFolders).
    let cursor: string | null = parent.parentFolderId;
    while (cursor) {
      if (cursor === folderId) throw new Error("Cannot move folder into its own subfolder");
      const ancestor: { parentFolderId: string | null } | null = await db.folder.findFirst({
        where: { id: cursor, ownerUserId },
        select: { parentFolderId: true },
      });
      cursor = ancestor?.parentFolderId ?? null;
    }
  }

  await db.folder.update({ where: { id: folderId }, data: { parentFolderId } });
  return true;
}

async function softDeleteFilesInTree(ownerUserId: string, folderId: string): Promise<void> {
  await db.file.updateMany({
    where: { ownerUserId, parentFolderId: folderId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const children = await db.folder.findMany({ where: { ownerUserId, parentFolderId: folderId } });
  for (const child of children) await softDeleteFilesInTree(ownerUserId, child.id);
}

async function deleteFolderTree(ownerUserId: string, folderId: string): Promise<void> {
  const children = await db.folder.findMany({ where: { ownerUserId, parentFolderId: folderId } });
  for (const child of children) await deleteFolderTree(ownerUserId, child.id);
  await db.folder.delete({ where: { id: folderId } });
}

export async function deleteFolder(ownerUserId: string, folderId: string): Promise<boolean> {
  const folder = await db.folder.findFirst({ where: { id: folderId, ownerUserId } });
  if (!folder) throw new Error("Folder not found");
  await softDeleteFilesInTree(ownerUserId, folderId);
  await deleteFolderTree(ownerUserId, folderId);
  return true;
}

export async function getFolders(ownerUserId: string, parentFolderId: string | null) {
  const folders = await db.folder.findMany({
    where: { ownerUserId, parentFolderId },
    orderBy: { createdAt: "asc" },
  });
  return enrichFolders(ownerUserId, folders);
}

export async function getFolderPath(ownerUserId: string, folderId: string) {
  const path: Awaited<ReturnType<typeof db.folder.findMany>> = [];
  let current: string | null = folderId;
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const folder: Awaited<ReturnType<typeof db.folder.findFirst>> = await db.folder.findFirst({
      where: { id: current, ownerUserId },
    });
    if (!folder) break;
    path.unshift(folder);
    current = folder.parentFolderId;
  }

  return enrichFolders(ownerUserId, path);
}
