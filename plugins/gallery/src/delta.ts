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

export const MAX_DELTA_ROWS = 1000;

// A truncated page may have cut off rows sharing the final row's updatedAt,
// so the safe cursor backs off to just before that timestamp — the next page
// re-fetches the boundary rows and clients dedupe by id. If every row in the
// page shares one timestamp there is nothing to back off to; advance to it
// (accepting a skip) rather than never making progress.
function fullPageCursor(rows: { updatedAt: Date }[]): Date {
  const last = rows[rows.length - 1]!.updatedAt;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.updatedAt < last) return rows[i]!.updatedAt;
  }
  return last;
}

export async function getDelta(
  userId: string,
  since: Date | null,
  pageSize: number = MAX_DELTA_ROWS,
): Promise<GalleryDelta> {
  const updatedFilter = since ? { updatedAt: { gt: since } } : {};

  const [files, folders] = await Promise.all([
    db.file.findMany({
      where: { ownerUserId: userId, ...updatedFilter },
      orderBy: { updatedAt: "asc" },
      take: pageSize,
    }),
    db.folder.findMany({
      where: { ownerUserId: userId, ...updatedFilter },
      orderBy: { updatedAt: "asc" },
      take: pageSize,
    }),
  ]);

  // Cursor advances to the newest change seen, but must never overtake the
  // last row of a FULL (row-capped) list — otherwise everything between that
  // list's cut-off and the other list's newest row would be skipped on the
  // next page (the >1000-files bug: a recently-updated folder used to fling
  // the cursor past ~2/3 of the library).
  let cursor = since ?? new Date(0);
  for (const row of [...files, ...folders]) {
    if (row.updatedAt > cursor) cursor = row.updatedAt;
  }
  for (const rows of [files, folders]) {
    if (rows.length >= pageSize) {
      const cap = fullPageCursor(rows);
      if (cap < cursor) cursor = cap;
    }
  }

  return { files, folders, cursor };
}
