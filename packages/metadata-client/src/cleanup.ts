// Trash and fragment cleanup in metadata only (DECISIONS Q4).
//
// Two steps, both run by a client (the server cannot read the tree and never holds a webhook):
//  1. Trash: nodes more than 30 days in the trash are purged with one group op (Q4 policy:
//     main device, fully synced, not metered; after 7 days without any cleanup any device).
//  2. Fragments: uploads released by a purge or a newer version are deleted from Discord only
//     when deletableUploadsWithRetention() says so: 30 days after the release AND no kept base
//     snapshot was taken before the release (a restored base must never point at a deleted
//     message). The manifest of a released version is gone from the tree, so its reference is
//     found again in the log (the op that bound the upload). Fragment messages go first, the
//     manifest message last: a run cut short can be repeated from the manifest.
// The server records which uploads are done (upload IDs are already plaintext there), so
// another device does not delete the same messages again; it also gives the server clock.

import { DAY_MS, FRAGMENT_RETENTION_MS, type ContentRef, type IndexStore, type Operation } from "@ddv4/sync-core";
import type { ArbiterApi } from "./arbiter.js";
import { decodeManifestRef, type DriveClient } from "./drive-client.js";
import { RateLimitedError } from "./discord-transport.js";
import { decideTrashCleanup, trashCleanupOp } from "./policies.js";
import { deletableUploadsWithRetention, emptyPointer, type Pointer } from "./snapshots.js";
import type { DiscordPlacement, WebhookRef, WebhookTransport } from "./types.js";

/** Server side of the cleanup bookkeeping (GET/POST /v1/gc). */
export interface CleanupApi {
  status(): Promise<CleanupServerStatus>;
  /** Which of these uploads another device already deleted. */
  done(uploadIds: string[]): Promise<string[]>;
  record(r: { uploads: string[]; run: boolean }): Promise<void>;
}

export interface CleanupServerStatus {
  /** Server clock (retention is measured on it, never on the device clock). */
  now: number;
  /** Last cleanup run of this account by any device, null = never. */
  lastRunAt: number | null;
  /** Server time of the account's first log entry (the 7-day clock of a fresh account). */
  firstEntryAt: number | null;
  /** Uploads whose fragments were deleted so far. */
  doneCount: number;
}

export interface CleanupDeps {
  client: DriveClient;
  /** The log (reads the op that bound a released upload, for its manifest). */
  log: Pick<ArbiterApi, "read">;
  api: CleanupApi;
  transport: WebhookTransport;
  webhook(id: string): WebhookRef;
  /** Webhooks removed from the account: their messages can never be deleted by us; skipped. */
  removedHook?(id: string): boolean;
  /** Current snapshot pointer (kept bases); null = no snapshots yet. */
  pointer(): Promise<Pointer | null>;
  isPrimary(): boolean;
  metered(): boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface CleanupReport {
  ranAt: number;
  /** Why the trash step did not run (Q4), or null when it did. */
  trashSkipped: string | null;
  /** Items purged from the trash (top-level nodes asked for). */
  purged: number;
  /** Q3: items another device changed unseen, kept 30 more days. */
  kept: number;
  /** Uploads whose fragments were deleted in this run. */
  uploads: number;
  messages: number;
  bytes: number;
  /** Uploads left for a later run (webhook no longer in the vault, Discord errors, run limit). */
  left: number;
}

export interface CleanupPreview {
  /** Items more than 30 days in the trash (purged by the next run). */
  expired: number;
  /** Released uploads still inside the retention window (or held by a kept base). */
  waiting: number;
  /** Released uploads whose fragments the next run deletes. */
  deletable: number;
  /** Plaintext bytes of those (from the version sizes). */
  deletableBytes: number;
  lastRunAt: number | null;
  /** When the oldest waiting upload becomes deletable (server time), null = nothing waits. */
  nextAt: number | null;
}

/** At most this many uploads per run (a run stays short; the next one continues). */
export const CLEANUP_MAX_UPLOADS = 200;

/**
 * The content (manifest) a released upload was bound to, read back from the log entry that bound
 * it. Only that entry counts (seq and version ID from the upload record): a rejected op naming
 * the same upload with another manifest must never steer the deletion.
 */
export async function findUploadContent(log: Pick<ArbiterApi, "read">, store: IndexStore, uploadId: string): Promise<ContentRef | null> {
  const u = store.getUpload(uploadId);
  const b = u?.boundTo;
  if (!b) return null;
  const [e] = await log.read(b.seq - 1, 1);
  if (!e || e.seq !== b.seq) return null;
  const ops: Operation[] = e.op?.type === "group" && Array.isArray(e.op.ops) ? e.op.ops : e.op ? [e.op] : [];
  let content: ContentRef | null = null;
  for (const o of ops) {
    const c = (o as { content?: ContentRef }).content;
    if ((o.type === "create" || o.type === "new_content_version") && c?.uploadId === uploadId && c.versionId === b.versionId) content = c;
  }
  // Rules v3: a relocated version's pieces are where its LAST relocate put them (the entry the upload names).
  // What the relocate replaced is the moved channel's business (drain in channels.ts), never this.
  if (content && u.relocated) {
    const [r] = await log.read(u.relocated.seq - 1, 1);
    const rops: Operation[] = r?.op?.type === "group" && Array.isArray(r.op.ops) ? r.op.ops : r?.op ? [r.op] : [];
    const rel = r?.seq === u.relocated.seq ? rops.find((o) => o.type === "relocate" && o.uploadId === uploadId && o.versionId === b.versionId) : undefined;
    if (!rel || rel.type !== "relocate") return null;
    content = { ...content, manifestRef: rel.manifestRef, ...(rel.pieces ? { pieces: rel.pieces } : {}) };
  }
  return content;
}

function deletableAndWaiting(store: IndexStore, pointer: Pointer | null, now: number): { deletable: string[]; waiting: { id: string; at: number }[] } {
  const p = pointer ?? emptyPointer();
  const deletable = deletableUploadsWithRetention(store, p, now);
  const set = new Set(deletable);
  const waiting: { id: string; at: number }[] = [];
  for (const u of store.allUploads()) if (u.status === "released" && u.ended && !set.has(u.id)) waiting.push({ id: u.id, at: u.ended.at + FRAGMENT_RETENTION_MS });
  return { deletable, waiting };
}

export class Cleaner {
  private running: Promise<CleanupReport> | null = null;
  last: CleanupReport | null = null;

  constructor(private readonly d: CleanupDeps) {}

  /** What the next run would do (Settings → Storage). */
  async preview(): Promise<CleanupPreview> {
    const st = await this.d.api.status();
    const store = this.d.client.store;
    const dec = decideTrashCleanup(store, { isPrimary: true, fullySynced: true, metered: false, now: st.now, lastPurgeAt: null, logStartedAt: null });
    const { deletable, waiting } = deletableAndWaiting(store, await this.d.pointer().catch(() => null), st.now);
    const notDone = deletable.length ? new Set(await this.d.api.done(deletable)) : new Set<string>();
    const todo = deletable.filter((id) => !notDone.has(id) && store.getUpload(id)?.status === "released");
    let bytes = 0;
    for (const id of todo.slice(0, CLEANUP_MAX_UPLOADS)) bytes += (await findUploadContent(this.d.log, store, id).catch(() => null))?.sizeBytes ?? 0;
    return {
      expired: dec.clean ? dec.nodeIds.length : 0,
      waiting: waiting.length,
      deletable: todo.length,
      deletableBytes: bytes,
      lastRunAt: st.lastRunAt,
      nextAt: waiting.length ? Math.min(...waiting.map((w) => w.at)) : null,
    };
  }

  /**
   * One cleanup run. `manual` (the "Clean up now" button): the user asked on this device, so the
   * main-device rule and the metered-link rule do not apply; being fully synced still does.
   */
  run(manual = false): Promise<CleanupReport> {
    this.running ??= this.runNow(manual).finally(() => (this.running = null));
    return this.running;
  }

  private async runNow(manual: boolean): Promise<CleanupReport> {
    const c = this.d.client;
    await c.pull();
    const st = await this.d.api.status();
    const report: CleanupReport = { ranAt: st.now, trashSkipped: null, purged: 0, kept: 0, uploads: 0, messages: 0, bytes: 0, left: 0 };
    const fullySynced = c.replica.unsent === 0;
    Object.assign(report, await purgeExpiredTrash(c, st, { primary: this.d.isPrimary(), metered: this.d.metered(), manual }));
    // Fragments: same Q4 gate as the trash (main device, unmetered; after 7 days without any run, any
    // unmetered device), always only when fully synced.
    const stale = st.now - (st.lastRunAt ?? st.firstEntryAt ?? st.now) >= 7 * DAY_MS;
    if (!fullySynced || (!manual && (this.d.metered() || (!this.d.isPrimary() && !stale)))) {
      this.last = report;
      return report;
    }
    const { deletable } = deletableAndWaiting(c.store, await this.d.pointer(), st.now);
    const alreadyDone = deletable.length ? new Set(await this.d.api.done(deletable)) : new Set<string>();
    const todo = deletable.filter((id) => !alreadyDone.has(id));
    const finished: string[] = [];
    for (const id of todo) {
      if (finished.length >= CLEANUP_MAX_UPLOADS) {
        report.left++;
        continue;
      }
      const u = c.store.getUpload(id)!;
      if (u.status === "aborted") {
        // Rule 8: an aborted upload never got a manifest; its blobs (if any) are unknown to the index.
        finished.push(id);
        continue;
      }
      try {
        const content = await findUploadContent(this.d.log, c.store, id);
        if (!content) {
          finished.push(id);
          continue;
        }
        const out = await this.deleteVersion(content.manifestRef);
        report.messages += out.messages;
        report.bytes += out.bytes;
        report.uploads++;
        finished.push(id);
      } catch {
        report.left++;
      }
      // Record as we go (a closed tab must not repeat finished uploads).
      if (finished.length % 20 === 0) await this.d.api.record({ uploads: finished.splice(0), run: false }).catch(() => {});
    }
    await this.d.api.record({ uploads: finished, run: true });
    this.last = report;
    return report;
  }

  /** Delete the messages of one version: fragments first, the manifest last. 404 = already gone. */
  private async deleteVersion(manifestRef: string): Promise<{ messages: number; bytes: number }> {
    const loc = decodeManifestRef(manifestRef);
    let chunks: { placements?: unknown[]; ciphertextSizeBytes: number }[];
    try {
      chunks = (await this.d.client.loadManifest(manifestRef)).manifest.chunks;
    } catch (e) {
      // The manifest message itself is gone: a previous run finished the fragments already.
      if (/404|Unknown Message|attachment missing/.test(String((e as Error)?.message ?? e))) return { messages: 0, bytes: 0 };
      throw e;
    }
    let messages = 0;
    let bytes = 0;
    for (const ch of chunks) {
      const p = ch.placements?.[0] as DiscordPlacement | undefined;
      if (!p) continue;
      if (await this.deleteMessage(p)) messages++;
      bytes += ch.ciphertextSizeBytes;
    }
    if (await this.deleteMessage(loc.at)) messages++;
    return { messages, bytes };
  }

  private async deleteMessage(p: DiscordPlacement): Promise<boolean> {
    // Removed from the account ("remove anyway" or a finished drain): no URL left to delete with; the message stays on Discord.
    if (this.d.removedHook?.(p.locationId)) return false;
    const hook = this.d.webhook(p.locationId); // throws when the webhook is unknown: the upload stays for later
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        await this.d.transport.deleteMessage(hook, p.messageId);
        return true;
      } catch (e) {
        if (/404|Unknown Message/.test(String((e as Error)?.message ?? e))) return false;
        if (e instanceof RateLimitedError && attempt < 8) {
          await sleep(Math.min(e.retryAfterMs, 30_000));
          continue;
        }
        throw e;
      }
    }
  }
}

/**
 * Step 1 of every mode: purge what is more than 30 days in the trash (Q4 gates; `manual` = the
 * user pressed "Clean up now" on this device, so the main-device and metered rules do not apply).
 * A client step in every mode: in e2ee the server cannot write operations (they are sealed with
 * the account key), and plain keeps the same path so the rules stay in one place.
 */
export async function purgeExpiredTrash(
  c: DriveClient,
  st: Pick<CleanupServerStatus, "now" | "lastRunAt" | "firstEntryAt">,
  o: { primary: boolean; metered: boolean; manual: boolean },
): Promise<{ trashSkipped: string | null; purged: number; kept: number }> {
  const dec = decideTrashCleanup(c.store, {
    isPrimary: o.manual || o.primary,
    fullySynced: c.replica.unsent === 0,
    metered: !o.manual && o.metered,
    now: st.now,
    lastPurgeAt: Math.max(c.observer.lastPurgeAt ?? 0, st.lastRunAt ?? 0) || null,
    logStartedAt: c.observer.logStartedAt ?? st.firstEntryAt,
  });
  if (!dec.clean) return { trashSkipped: dec.reason, purged: 0, kept: 0 };
  const r = await c.commitOp(trashCleanupOp(dec.nodeIds), "trash cleanup");
  return { trashSkipped: null, purged: dec.nodeIds.length, kept: r.notices.filter((n) => n.code === "purge_kept_unseen").reduce((s, n) => s + (n.items?.length ?? 0), 0) };
}

/**
 * Released uploads in the index after `afterSeq` (e2ee/plain clients report them to the instance,
 * which deletes their fragments FRAGMENT_RETENTION_MS after the release; aborted uploads are the
 * instance's own business: it deleted them at cancel or reaped them).
 */
export function releasedUploads(store: IndexStore, afterSeq = 0): { uploadId: string; at: number; seq: number }[] {
  const out: { uploadId: string; at: number; seq: number }[] = [];
  for (const u of store.allUploads()) if (u.status === "released" && u.ended && u.ended.seq > afterSeq) out.push({ uploadId: u.id, at: u.ended.at, seq: u.ended.seq });
  return out.sort((a, b) => a.seq - b.seq);
}
