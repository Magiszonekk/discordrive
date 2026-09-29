// Garbage collection decisions (koncept §6.2, rule 8). Pure functions over the
// index; the caller does the actual deleting (Discord) and issues the ops.

import { inTrash } from "./apply.js";
import type { IndexStore } from "./store.js";
import type { NodeId, UploadId } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Trash retention (§6.2: „Kosz: 30 dni”). */
export const TRASH_RETENTION_MS = 30 * DAY_MS;
/** Fragments of purged/superseded versions stay this long, so every kept base snapshot still resolves (§6.2). */
export const FRAGMENT_RETENTION_MS = 30 * DAY_MS;

/**
 * Uploads whose fragments may be physically deleted now:
 *  - aborted: right away (never referenced by any file version, rule 8),
 *  - released (purged or superseded version): after FRAGMENT_RETENTION_MS.
 * Both states are terminal: such an upload can never be referenced again.
 * Open/committed/bound uploads are never deletable; abandoned open uploads
 * must first be aborted through the log (after their lease expired).
 */
export function deletableUploads(store: IndexStore, nowServerMs: number, retentionMs = FRAGMENT_RETENTION_MS): UploadId[] {
  const out: UploadId[] = [];
  for (const u of store.allUploads()) {
    if (u.status === "aborted") out.push(u.id);
    else if (u.status === "released" && u.ended && u.ended.at + retentionMs <= nowServerMs) out.push(u.id);
  }
  return out.sort();
}

/** Nodes trashed long enough ago to be purged automatically (top-level trashed nodes only). */
export function expiredTrash(store: IndexStore, nowServerMs: number, retentionMs = TRASH_RETENTION_MS): NodeId[] {
  const out: NodeId[] = [];
  for (const n of store.allNodes()) {
    if (!n.trashed || n.trashed.at + retentionMs > nowServerMs) continue;
    // Skip if an ancestor is also trashed: purging the ancestor covers it.
    if (n.parentId !== null && inTrash(store, n.parentId)) continue;
    out.push(n.id);
  }
  return out.sort();
}
