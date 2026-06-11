// Gallery plugin — incremental sync delta
//
// Mobile clients poll "what changed since my cursor" instead of re-listing the
// whole library. Built on the updatedAt columns the core already maintains, so
// it covers uploads, moves, renames, trash/restore and purges-by-soft-delete.
// Hard-purged files simply stop appearing; clients reconcile those during the
// periodic full listing (recommended ~daily).

import { db } from "@ddv4/database";

export interface GalleryDelta {
  files: Awaited<ReturnType<typeof db.file.findMany>>;
  folders: Awaited<ReturnType<typeof db.folder.findMany>>;
  cursor: Date;
}

const MAX_DELTA_ROWS = 1000;

export async function getDelta(userId: string, since: Date | null): Promise<GalleryDelta> {
  const updatedFilter = since ? { updatedAt: { gt: since } } : {};

  const [files, folders] = await Promise.all([
    db.file.findMany({
      where: { ownerUserId: userId, ...updatedFilter },
      orderBy: { updatedAt: "asc" },
      take: MAX_DELTA_ROWS,
    }),
    db.folder.findMany({
      where: { ownerUserId: userId, ...updatedFilter },
      orderBy: { updatedAt: "asc" },
      take: MAX_DELTA_ROWS,
    }),
  ]);

  // Cursor advances to the newest change seen; clients pass it back as `since`.
  // When a page is full (MAX_DELTA_ROWS) the cursor intentionally stays at the
  // last returned row so the next poll picks up the remainder.
  let cursor = since ?? new Date(0);
  for (const row of [...files, ...folders]) {
    if (row.updatedAt > cursor) cursor = row.updatedAt;
  }

  return { files, folders, cursor };
}
