// Invariant checks that are independent of apply.ts: they look at the log and
// the final state and ask "was anything lost that nobody deleted?".

import {
  inTrash,
  type IndexStore,
  type LogEntry,
  type NodeRecord,
  type SingleOp,
} from "../src/index.js";

function subOps(e: LogEntry): SingleOp[] {
  return e.op.type === "group" ? e.op.ops : [e.op];
}

/**
 * „Żadna treść nie ginie bez operacji usunięcia” (task invariant, koncept §5.2.3):
 * every content version that was ever bound is still bound to a node, or it
 * was released by
 *  - an explicit replacement: a new_content_version on that node whose
 *    author based it on exactly that version, or
 *  - a purge whose author had seen the version (own op or baseSeq >= binding).
 */
export function checkNoSilentLoss(log: LogEntry[], store: IndexStore): string[] {
  const errs: string[] = [];
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  for (const u of store.allUploads()) {
    if (!u.boundTo) continue;
    if (u.status === "bound") {
      const n = store.getNode(u.boundTo.nodeId);
      if (!n || n.content?.uploadId !== u.id) errs.push(`bound upload ${u.id} not on its node`);
      continue;
    }
    if (u.status !== "released" || !u.ended) {
      errs.push(`upload ${u.id} has boundTo but status ${u.status}`);
      continue;
    }
    const e = bySeq.get(u.ended.seq);
    if (!e) {
      errs.push(`upload ${u.id} released by unknown seq ${u.ended.seq}`);
      continue;
    }
    if (u.ended.reason === "superseded") {
      const ok = subOps(e).some(
        (o) => o.type === "new_content_version" && o.baseVersionId === u.boundTo!.versionId,
      );
      if (!ok) errs.push(`upload ${u.id} superseded by seq ${e.seq} that was not based on it`);
    } else if (u.ended.reason === "purged") {
      const isPurge = subOps(e).some((o) => o.type === "purge");
      const seen = e.device.id === u.boundTo.deviceId || e.baseSeq >= u.boundTo.seq;
      if (!isPurge) errs.push(`upload ${u.id} purged by non-purge seq ${e.seq}`);
      if (!seen) errs.push(`upload ${u.id} purged by seq ${e.seq} whose author had not seen it (bound at ${u.boundTo.seq})`);
    } else {
      errs.push(`bound upload ${u.id} ended with ${u.ended.reason}`);
    }
  }
  return errs;
}

/**
 * „Nowa treść zawsze ląduje w widocznym miejscu” (§5.2.3): a file that sits in
 * the trash was put there (itself or through an ancestor) by someone who had
 * seen its current content.
 */
export function checkTrashSawContent(log: LogEntry[], store: IndexStore): string[] {
  const errs: string[] = [];
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  for (const n of store.allNodes()) {
    if (n.kind !== "file" || !n.content || !inTrash(store, n.id)) continue;
    let t: NodeRecord | undefined = n;
    while (t && !t.trashed) t = t.parentId === null ? undefined : store.getNode(t.parentId);
    if (!t?.trashed) {
      errs.push(`file ${n.id} in trash but no trashed ancestor`);
      continue;
    }
    const e = bySeq.get(t.trashed.seq);
    if (!e) {
      errs.push(`file ${n.id} trashed by unknown seq`);
      continue;
    }
    const seen = e.device.id === n.content.device.id || e.baseSeq >= n.content.seq;
    if (!seen || n.content.seq >= t.trashed.seq) {
      errs.push(`file ${n.id} (content seq ${n.content.seq}) is in the trash via ${t.id} trashed at ${t.trashed.seq} by an author who had not seen it`);
    }
  }
  return errs;
}

/** No file version points at fragments that were physically deleted. */
export function checkNoDeletedFragments(store: IndexStore, deleted: ReadonlySet<string>): string[] {
  const errs: string[] = [];
  for (const n of store.allNodes()) {
    if (n.content && deleted.has(n.content.uploadId)) errs.push(`file ${n.id} points at deleted fragments of ${n.content.uploadId}`);
  }
  return errs;
}
