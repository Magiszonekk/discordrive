// Invariant checks that are independent of apply.ts: they look at the log and
// the final state and ask "was anything lost that nobody deleted?".

import {
  inTrash,
  type ApplyResult,
  type IndexStore,
  type LogEntry,
  type NodeRecord,
  type SingleOp,
} from "../src/index.js";

function subOps(e: LogEntry): SingleOp[] {
  return e.op.type === "group" ? e.op.ops : [e.op];
}

/**
 * „Żadna treść nie ginie bez operacji usunięcia” (task invariant):
 * every content version that was ever bound is still bound to a node, or it
 * was released by
 *  - an explicit replacement: a new_content_version on that node whose
 *    author based it on exactly that version, or
 *  - a replacement with identical plaintext (same plaintextSha256, Q7), or
 *  - a purge whose author had seen the version (own op or baseSeq >= binding).
 */
export function checkNoSilentLoss(log: LogEntry[], store: IndexStore): string[] {
  const errs: string[] = [];
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const hashOf = new Map<string, string>();
  for (const e of log) {
    for (const o of subOps(e)) {
      const c = o.type === "create" ? o.content : o.type === "new_content_version" ? o.content : undefined;
      if (c?.plaintextSha256) hashOf.set(c.versionId, c.plaintextSha256);
    }
  }
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
      const oldHash = hashOf.get(u.boundTo.versionId);
      const ok = subOps(e).some(
        (o) =>
          o.type === "new_content_version" &&
          (o.baseVersionId === u.boundTo!.versionId || (oldHash !== undefined && o.content.plaintextSha256 === oldHash)),
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
 * I4b, „niewidziana treść nie znika po cichu” (with the
 * folder exception, owner decisions Q1 + #11, DECISIONS.md). A file that sits
 * in the trash with its current content is fine if:
 *  - whoever trashed it (itself or through an ancestor) had seen that
 *    content, or
 *  - it went to the trash TOGETHER WITH A FOLDER (the trashed node is a
 *    proper ancestor, never the file itself: trashing the file alone is
 *    skipped, Q2) and the content's author got an
 *    `unseen_trashed_with_folder` notice from that trash entry, about the
 *    file or one of its ancestors up to the trashed folder.
 * Content can never land in the trash after the trash op (rule 3 brings it
 * back). That it stays restorable (no purge without seeing it) is checked
 * by checkNoSilentLoss.
 */
export function checkTrashSawContent(log: LogEntry[], store: IndexStore, results: ApplyResult[]): string[] {
  const errs: string[] = [];
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const told = new Set<string>();
  for (const r of results) {
    for (const n of r.notices) {
      if (n.code === "unseen_trashed_with_folder" && n.nodeId !== undefined && n.notifyDeviceId !== undefined) {
        told.add(`${n.seq}\u0000${n.notifyDeviceId}\u0000${n.nodeId}`);
      }
    }
  }
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
    if (n.content.seq >= t.trashed.seq) {
      errs.push(`file ${n.id} got content at ${n.content.seq} after its trash at ${t.trashed.seq} and stayed in the trash`);
      continue;
    }
    const seen = e.device.id === n.content.device.id || e.baseSeq >= n.content.seq;
    if (seen) continue;
    if (t === n || t.kind !== "folder") {
      errs.push(`file ${n.id} with unseen content (seq ${n.content.seq}) was trashed directly at ${t.trashed.seq} (Q2 says skip)`);
      continue;
    }
    // Chain file .. t (inclusive): did the content author get a notice for any of them?
    let notified = false;
    for (let c: NodeRecord | undefined = n; c; c = c === t || c.parentId === null ? undefined : store.getNode(c.parentId)) {
      if (told.has(`${t.trashed.seq}\u0000${n.content.device.id}\u0000${c.id}`)) {
        notified = true;
        break;
      }
    }
    if (!notified) {
      errs.push(`file ${n.id} (content seq ${n.content.seq}) is in the trash via ${t.id} trashed at ${t.trashed.seq} by an author who had not seen it, and its author was not notified`);
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
