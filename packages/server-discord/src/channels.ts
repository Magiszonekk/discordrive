// Removing a channel (webhook) of the e2ee/plain instance.
//
// Three ways out for a webhook W (account scope: Settings → Channels; pool scope: the operator,
// `discordrive channels`):
//   retire          W takes no new blobs (hooksFor skips it), still read; instant, reversible.
//   move and remove a background job copies every live blob on W to the account's other active
//                   channels (the pool when it has none), through the DiscordSender (per-channel
//                   pacing), rewrites snapshot chains that touch W, deletes the old messages and
//                   only then takes W out of the instance (inst_hooks_removed, how "moved").
//                   Resumable: the job row (s_moves) and the blob rows are the state; a moved blob
//                   is no longer on W, so a restarted job continues where it stopped.
//   remove anyway   W leaves the instance at once; blobs on it stay on Discord but cannot be read
//                   (no URL to ask with). "Unavailable" is computed from s_blobs (a blob on a webhook
//                   that is not in inst_hooks), never written anywhere, so pasting the same webhook
//                   again (same ID) makes them readable at once on every device. With an instance bot,
//                   `recover` reads them through refresh-urls and moves them to active channels.
// Critical = W holds an account's snapshot pointer or a segment of its chain (s_snapshots,
// s_snap_objs): only "move and remove" (409 channel_critical for the others), because the chain is
// what rebuilds the account's log after losing the database. The last place an account can post to
// is never retired/removed (409 need_other_channel).
//
// Aliases: the client's manifests (encrypted in e2ee) keep the ORIGINAL placements forever and the
// server can never rewrite them, so a moved blob keeps answering for its old attachment ID:
// s_blob_alias(old attachment → account, upload, index) → the current s_blobs row. Every lookup by
// attachment ID (POST /v1/blobs/urls, GET /v1/blobs/<att>, describe, share links, plain reads) goes
// through resolveBlob().

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BLOB_EXT } from "@ddv4/metadata-client";
import { POOL, type InstanceHooks, type HookInfo } from "./instance-hooks.js";
import type { SenderHook } from "./sender.js";
import { snapshotTables } from "./snapshots-ext.js";

/** Rough throughput of one channel for ETAs (~30 posts/min of ≤ 10 MiB → a few MiB/s). */
export const MOVE_BYTES_PER_S_PER_CHANNEL = 4 * 1024 * 1024;
export const MOVE_POSTS_PER_MIN_PER_CHANNEL = 30;
/** A paused job (Discord unavailable, network) is retried this long after the failure. */
export const MOVE_RETRY_MS = 60_000;
/** Upload IDs returned by the impact endpoint (names are resolved in the browser). */
export const IMPACT_MAX_UPLOADS = 20_000;

/** Upload states whose blobs are live files (final = commit on its way, committed = in the log). */
const LIVE = "('final', 'committed')";
/** Blobs of these uploads are garbage waiting for deletion: never moved. */
const GARBAGE = "('aborted', 'reaped', 'purged')";

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ChannelError";
  }
}

export interface BlobRowLike {
  account_id: string;
  upload_id: string;
  idx: string;
  sha256: string;
  size: number;
  webhook_id: string;
  channel_id: string;
  message_id: string;
  attachment_id: string;
  filename: string;
  created_at: number;
  deleted_at: number | null;
}

/** Tables of blobs through the instance (BlobsExtension) + what removing channels adds. */
export function blobTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS s_uploads (
      account_id TEXT NOT NULL, upload_id TEXT NOT NULL, state TEXT NOT NULL,
      device_id TEXT NOT NULL, created_at INTEGER NOT NULL, active_at INTEGER NOT NULL,
      final_at INTEGER, released_at INTEGER, guarded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, upload_id));
    CREATE INDEX IF NOT EXISTS s_uploads_state ON s_uploads(state, active_at);
    CREATE TABLE IF NOT EXISTS s_blobs (
      account_id TEXT NOT NULL, upload_id TEXT NOT NULL, idx TEXT NOT NULL, sha256 TEXT NOT NULL,
      size INTEGER NOT NULL, webhook_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER,
      PRIMARY KEY (account_id, upload_id, idx));
    CREATE INDEX IF NOT EXISTS s_blobs_att ON s_blobs(attachment_id);
    CREATE INDEX IF NOT EXISTS s_blobs_hook ON s_blobs(webhook_id, account_id);
    CREATE TABLE IF NOT EXISTS s_blob_alias (
      attachment_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, upload_id TEXT NOT NULL, idx TEXT NOT NULL, moved_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS s_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, webhook_id TEXT NOT NULL, label TEXT NOT NULL,
      kind TEXT NOT NULL, state TEXT NOT NULL, critical INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, bytes_total INTEGER NOT NULL DEFAULT 0,
      bytes_done INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS s_moves_scope ON s_moves(scope, id);
    CREATE TABLE IF NOT EXISTS s_move_trash (job_id INTEGER NOT NULL, webhook_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (job_id, message_id));
  `);
  // Uploads committed outside the log (the Safe): never reaped; released by their client; listed for it.
  if (!(db.prepare("PRAGMA table_info(s_uploads)").all() as { name: string }[]).some((c) => c.name === "outside")) db.exec("ALTER TABLE s_uploads ADD COLUMN outside INTEGER NOT NULL DEFAULT 0");
}

export interface ChannelStats {
  /** Live files (uploads final/committed) with at least one blob here. */
  files: number;
  bytes: number;
  /** Every live blob here (garbage excluded): what a move copies. */
  blobs: number;
  blobBytes: number;
  /** Snapshot objects here and the bytes of the chains a move rewrites. */
  critical: boolean;
  criticalWhat: ("pointer" | "snapshots")[];
  /** Accounts whose chain touches this webhook. */
  chainAccounts: string[];
  chainBytes: number;
}

export interface MoveJobRow {
  id: number;
  scope: string;
  webhook_id: string;
  label: string;
  kind: "move" | "recover";
  state: "queued" | "running" | "paused" | "done" | "failed";
  critical: number;
  total: number;
  done: number;
  bytes_total: number;
  bytes_done: number;
  started_at: number;
  updated_at: number;
  retry_at: number;
  error: string | null;
}

/** The browser contract's MoveStatus (apps/web-mo/src/modes/types.ts). */
export interface MoveStatusJson {
  webhookId: string;
  label: string;
  state: "running" | "paused" | "done" | "failed";
  critical: boolean;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  etaMs: number | null;
  error?: string;
  kind: "move" | "recover";
  queued?: boolean;
}

export function etaMs(bytes: number, blobs: number, channels: number): number {
  const ch = Math.max(1, channels);
  return Math.round(Math.max((bytes / (MOVE_BYTES_PER_S_PER_CHANNEL * ch)) * 1000, (blobs / (MOVE_POSTS_PER_MIN_PER_CHANNEL * ch)) * 60_000));
}

/**
 * Database side of channels: stats, impact, rules, jobs. No Discord access, so the operator CLI
 * uses it on the same database as the running server (WAL; the server picks up changes through
 * PRAGMA data_version in InstanceHooks and reads s_moves on its background tick).
 */
export class ChannelStore {
  constructor(
    readonly db: DatabaseSync,
    readonly hooks: InstanceHooks,
    private readonly now: () => number = () => Date.now(),
  ) {
    blobTables(db);
    snapshotTables(db);
  }

  // --- what lies where

  /** Stats of one webhook; `acct` limits them to one account (account scope). */
  stats(webhookId: string, acct?: string): ChannelStats {
    const a = acct ? " AND b.account_id = ?" : "";
    const args = acct ? [webhookId, acct] : [webhookId];
    const live = this.db
      .prepare(`SELECT count(DISTINCT b.account_id || '/' || b.upload_id) AS f, coalesce(sum(b.size), 0) AS s FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND u.state IN ${LIVE}${a}`)
      .get(...args) as { f: number; s: number };
    const all = this.db
      .prepare(`SELECT count(*) AS n, coalesce(sum(b.size), 0) AS s FROM s_blobs b LEFT JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND coalesce(u.state, 'open') NOT IN ${GARBAGE}${a}`)
      .get(...args) as { n: number; s: number };
    const crit = this.critical(webhookId, acct);
    const chainBytes = crit.accounts.length
      ? Number((this.db.prepare(`SELECT coalesce(sum(size), 0) AS s FROM s_snap_objs WHERE account_id IN (${crit.accounts.map(() => "?").join(",")})`).get(...crit.accounts) as { s: number }).s)
      : 0;
    return {
      files: Number(live.f),
      bytes: Number(live.s),
      blobs: Number(all.n),
      blobBytes: Number(all.s),
      critical: crit.what.length > 0,
      criticalWhat: crit.what,
      chainAccounts: crit.accounts,
      chainBytes,
    };
  }

  /** Does W hold a snapshot pointer or segments (of `acct`, or of any account)? */
  critical(webhookId: string, acct?: string): { what: ("pointer" | "snapshots")[]; accounts: string[] } {
    const a = acct ? " AND account_id = ?" : "";
    const args = acct ? [webhookId, acct] : [webhookId];
    const ptr = (this.db.prepare(`SELECT account_id FROM s_snapshots WHERE webhook_id = ?${a}`).all(...args) as { account_id: string }[]).map((r) => r.account_id);
    const seg = (this.db.prepare(`SELECT DISTINCT account_id FROM s_snap_objs WHERE webhook_id = ? AND kind IN ('segment', 'safe')${a}`).all(...args) as { account_id: string }[]).map((r) => r.account_id);
    const what: ("pointer" | "snapshots")[] = [];
    if (ptr.length) what.push("pointer");
    if (seg.length) what.push("snapshots");
    return { what, accounts: [...new Set([...ptr, ...seg])].sort() };
  }

  /**
   * Chains not indexed yet in this scope (critical detection would miss their segments). A chain
   * whose pointer webhook is no longer here cannot be read or indexed at all: not counted.
   */
  unindexed(scope: string): string[] {
    const rows = this.db.prepare("SELECT account_id FROM s_snapshots WHERE objs_ok = 0 AND webhook_id IN (SELECT id FROM inst_hooks)").all() as { account_id: string }[];
    return rows.map((r) => r.account_id).filter((x) => scope === POOL || x === scope);
  }

  /** A webhook of this scope (live or retired), or 404. */
  own(scope: string, id: string): HookInfo {
    const h = this.hooks.info(id);
    if (!h || h.scope !== scope) throw new ChannelError(404, "no_such_channel");
    return h;
  }

  /** Active (not retired, not dead) webhooks of a scope except `but`. */
  activeOthers(scope: string, but: string): HookInfo[] {
    return this.hooks.list(scope).filter((h) => h.id !== but && !h.retired && h.alive);
  }

  /**
   * Channels that take this webhook's data when it goes: account scope = the account's other
   * active channels, else the pool (the account falls back to it); pool = the other active pool webhooks.
   */
  otherActive(scope: string, id: string): number {
    const own = this.activeOthers(scope, id).length;
    if (scope === POOL || own) return own;
    return this.activeOthers(POOL, id).length;
  }

  /** Distinct Discord channels of those targets (ETA: pacing is per channel). */
  private targetChannels(scope: string, id: string): number {
    const own = this.activeOthers(scope, id);
    const list = scope !== POOL && !own.length ? this.activeOthers(POOL, id) : own;
    return new Set(list.map((h) => h.channelId)).size;
  }

  // --- the remove dialog

  impact(scope: string, id: string): {
    webhookId: string;
    label: string;
    critical: boolean;
    criticalWhat: ("pointer" | "snapshots")[];
    files: number;
    bytes: number;
    uploads: string[];
    more: number;
    otherActive: number;
    moveBytes: number;
    moveEtaMs: number | null;
    retired: boolean;
  } {
    const h = this.own(scope, id);
    const acct = scope === POOL ? undefined : scope;
    const st = this.stats(id, acct);
    const uploads = (this.db
      .prepare(`SELECT DISTINCT b.upload_id FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND u.state IN ${LIVE}${acct ? " AND b.account_id = ?" : ""} ORDER BY b.upload_id LIMIT ?`)
      .all(...(acct ? [id, acct, IMPACT_MAX_UPLOADS] : [id, IMPACT_MAX_UPLOADS])) as { upload_id: string }[]).map((r) => r.upload_id);
    const moveBytes = st.blobBytes + st.chainBytes;
    const ch = this.targetChannels(scope, id);
    return {
      webhookId: id,
      label: h.label,
      critical: st.critical,
      criticalWhat: st.criticalWhat,
      files: st.files,
      bytes: st.bytes,
      uploads,
      more: Math.max(0, st.files - uploads.length),
      otherActive: this.otherActive(scope, id),
      moveBytes,
      moveEtaMs: ch ? etaMs(moveBytes, st.blobs + st.chainAccounts.length, ch) : null,
      retired: h.retired,
    };
  }

  // --- rules + actions without Discord

  private activeJobFor(id: string): MoveJobRow | undefined {
    return this.db.prepare("SELECT * FROM s_moves WHERE webhook_id = ? AND state IN ('queued', 'running', 'paused') ORDER BY id DESC LIMIT 1").get(id) as MoveJobRow | undefined;
  }

  /** Option 1 and its undo. Retiring a critical webhook or the last active one is refused. */
  retire(scope: string, id: string, retired: boolean): void {
    const h = this.own(scope, id);
    if (this.activeJobFor(id)) throw new ChannelError(409, "move_running");
    if (retired && !h.retired) {
      if (this.unindexed(scope).length) throw new ChannelError(409, "index_pending");
      if (this.critical(id, scope === POOL ? undefined : scope).what.length) throw new ChannelError(409, "channel_critical");
      // Same rule as move / remove: the account falls back to the pool when its own channels are all retired.
      if (!this.otherActive(scope, id)) throw new ChannelError(409, "need_other_channel");
    }
    if (h.retired !== retired) this.hooks.setRetired(id, retired);
  }

  /** Option 3: the webhook leaves; its files become unavailable (nothing deleted). */
  removeAnyway(scope: string, id: string): void {
    this.own(scope, id);
    if (this.activeJobFor(id)) throw new ChannelError(409, "move_running");
    if (this.unindexed(scope).length) throw new ChannelError(409, "index_pending");
    if (this.critical(id, scope === POOL ? undefined : scope).what.length) throw new ChannelError(409, "channel_critical");
    if (!this.otherActive(scope, id)) throw new ChannelError(409, "need_other_channel");
    this.hooks.remove(scope, id, "removed");
  }

  /**
   * Option 2: queue a move job (the server's background tick runs it; the API also kicks it at
   * once). W is retired right away so nothing new lands on it while the job copies.
   */
  enqueueMove(scope: string, id: string): MoveJobRow {
    const h = this.own(scope, id);
    const running = this.activeJobFor(id);
    if (running) return running;
    if (!this.otherActive(scope, id)) throw new ChannelError(409, "need_other_channel");
    const busy = this.db.prepare("SELECT id FROM s_moves WHERE scope = ? AND state IN ('queued', 'running', 'paused')").get(scope);
    if (busy) throw new ChannelError(409, "move_running");
    const st = this.stats(id, scope === POOL ? undefined : scope);
    const t = this.now();
    if (!h.retired) this.hooks.setRetired(id, true);
    const r = this.db
      .prepare("INSERT INTO s_moves (scope, webhook_id, label, kind, state, critical, total, bytes_total, started_at, updated_at) VALUES (?, ?, ?, 'move', 'queued', ?, ?, ?, ?, ?)")
      .run(scope, id, h.label, st.critical ? 1 : 0, st.blobs + st.chainAccounts.length, st.blobBytes + st.chainBytes, t, t);
    return this.job(Number(r.lastInsertRowid))!;
  }

  /** Bot recovery of a removed webhook: move its blobs (read through the bot) to active channels. */
  enqueueRecover(scope: string, id: string, hasBot: boolean): MoveJobRow {
    const rm = this.hooks.removed(scope).find((x) => x.id === id);
    if (!rm) throw new ChannelError(404, "no_such_channel");
    if (!hasBot) throw new ChannelError(409, "no_bot");
    const running = this.activeJobFor(id);
    if (running) return running;
    const targets = scope === POOL ? this.activeOthers(POOL, id) : this.activeOthers(scope, id).length ? this.activeOthers(scope, id) : this.activeOthers(POOL, id);
    if (!targets.length) throw new ChannelError(409, "need_other_channel");
    const st = this.stats(id, scope === POOL ? undefined : scope);
    const t = this.now();
    const r = this.db
      .prepare("INSERT INTO s_moves (scope, webhook_id, label, kind, state, total, bytes_total, started_at, updated_at) VALUES (?, ?, ?, 'recover', 'queued', ?, ?, ?, ?)")
      .run(scope, id, rm.label, st.blobs, st.blobBytes, t, t);
    return this.job(Number(r.lastInsertRowid))!;
  }

  job(id: number): MoveJobRow | undefined {
    return this.db.prepare("SELECT * FROM s_moves WHERE id = ?").get(id) as MoveJobRow | undefined;
  }

  lastJob(scope: string): MoveJobRow | undefined {
    return this.db.prepare("SELECT * FROM s_moves WHERE scope = ? ORDER BY id DESC LIMIT 1").get(scope) as MoveJobRow | undefined;
  }

  /** Jobs to run now: queued, interrupted (running at a restart), paused past their retry time. */
  dueJobs(): MoveJobRow[] {
    return this.db.prepare("SELECT * FROM s_moves WHERE state IN ('queued', 'running') OR (state = 'paused' AND retry_at <= ?) ORDER BY id").all(this.now()) as unknown as MoveJobRow[];
  }

  status(j: MoveJobRow | undefined): MoveStatusJson | null {
    if (!j) return null;
    let eta: number | null = null;
    if (j.state !== "done" && j.state !== "failed") {
      const left = Math.max(0, j.bytes_total - j.bytes_done);
      const el = j.updated_at - j.started_at;
      if (j.bytes_done > 0 && el > 0) eta = Math.round((left * el) / j.bytes_done);
      else {
        const ch = this.targetChannels(j.scope, j.webhook_id);
        eta = ch ? etaMs(left, Math.max(0, j.total - j.done), ch) : null;
      }
    }
    return {
      webhookId: j.webhook_id,
      label: j.label,
      state: j.state === "queued" ? "running" : j.state,
      critical: j.critical === 1,
      done: j.done,
      total: Math.max(j.total, j.done),
      bytesDone: j.bytes_done,
      bytesTotal: Math.max(j.bytes_total, j.bytes_done),
      startedAt: j.started_at,
      updatedAt: j.updated_at,
      etaMs: eta,
      ...(j.error ? { error: j.error } : {}),
      kind: j.kind,
      ...(j.state === "queued" ? { queued: true } : {}),
    };
  }

  // --- what cannot be read now

  /** Live uploads with a blob on a webhook that is not in the instance (computed, never stored). */
  unavailable(acct: string): { uploadId: string; webhookIds: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT b.upload_id, b.webhook_id FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id)
         WHERE b.account_id = ? AND b.deleted_at IS NULL AND u.state IN ${LIVE} AND b.webhook_id NOT IN (SELECT id FROM inst_hooks) ORDER BY b.upload_id`,
      )
      .all(acct) as { upload_id: string; webhook_id: string }[];
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.upload_id, [...(m.get(r.upload_id) ?? []), r.webhook_id]);
    return [...m].map(([uploadId, webhookIds]) => ({ uploadId, webhookIds }));
  }

  /** Removed webhooks of a scope with the live files still only there. */
  removed(scope: string): { id: string; channelId: string; label: string; removedAt: number; how: "moved" | "removed"; unavailableFiles: number }[] {
    return this.hooks.removed(scope).map((r) => {
      const n = this.db
        .prepare(`SELECT count(DISTINCT b.account_id || '/' || b.upload_id) AS n FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND u.state IN ${LIVE}${scope === POOL ? "" : " AND b.account_id = ?"}`)
        .get(...(scope === POOL ? [r.id] : [r.id, scope])) as { n: number };
      return { id: r.id, channelId: r.channelId, label: r.label, removedAt: r.removedAt, how: r.how, unavailableFiles: Number(n.n) };
    });
  }

  /** Bytes of an account on Discord: live blobs (fragments + manifests, ciphertext) + snapshot objects. */
  usage(acct: string): number {
    const b = this.db.prepare(`SELECT coalesce(sum(b.size), 0) AS s FROM s_blobs b LEFT JOIN s_uploads u USING (account_id, upload_id) WHERE b.account_id = ? AND b.deleted_at IS NULL AND coalesce(u.state, 'open') NOT IN ${GARBAGE}`).get(acct) as { s: number };
    const s = this.db.prepare("SELECT coalesce(sum(size), 0) AS s FROM s_snap_objs WHERE account_id = ?").get(acct) as { s: number };
    return Number(b.s) + Number(s.s);
  }

  /** Rows of a scope for lists (account API, operator CLI). */
  rows(scope: string): (HookInfo & { files: number; bytes: number; dependent: number; critical: boolean; criticalWhat: ("pointer" | "snapshots")[] })[] {
    return this.hooks.list(scope).map((h) => {
      const st = this.stats(h.id, scope === POOL ? undefined : scope);
      return { ...h, files: st.files, bytes: st.bytes, dependent: st.files, critical: st.critical, criticalWhat: st.criticalWhat };
    });
  }

  // --- aliases

  /** Blob row by attachment ID, through the alias of a moved blob (any account, or one). */
  resolveBlob(attachmentId: string, acct?: string): BlobRowLike | undefined {
    const a = acct ? " AND account_id = ?" : "";
    const args = acct ? [attachmentId, acct] : [attachmentId];
    const b = this.db.prepare(`SELECT * FROM s_blobs WHERE attachment_id = ?${a} AND deleted_at IS NULL`).get(...args) as BlobRowLike | undefined;
    if (b) return b;
    const al = this.db.prepare(`SELECT account_id, upload_id, idx FROM s_blob_alias WHERE attachment_id = ?${a}`).get(...args) as { account_id: string; upload_id: string; idx: string } | undefined;
    if (!al) return undefined;
    return this.db.prepare("SELECT * FROM s_blobs WHERE account_id = ? AND upload_id = ? AND idx = ? AND deleted_at IS NULL").get(al.account_id, al.upload_id, al.idx) as BlobRowLike | undefined;
  }
}

/** What the job runner needs from the server side (BlobsExtension + SnapshotsExtension + sender). */
export interface MoverDeps {
  store: ChannelStore;
  hooks: InstanceHooks;
  now: () => number;
  /** Bytes of a blob (fresh link through the bot, else through its webhook). */
  readBlob(b: BlobRowLike): Promise<Uint8Array>;
  post(targets: SenderHook[], data: Uint8Array, filename: string): Promise<{ locationId: string; channelId: string; messageId: string; attachmentId: string; url: string }>;
  deleteMessage(hook: SenderHook, messageId: string): Promise<void>;
  /** Wait until no blob upload that may still land on `webhookId` is in flight. */
  idleFor(webhookId: string): Promise<void>;
  /** Delete the blobs of a garbage upload (aborted/reaped/purged) now. */
  deleteUpload(acct: string, uploadId: string): Promise<void>;
  /** A link the server may cache for the new attachment (and the old one's cache entry to drop). */
  remember?(attachmentId: string, url: string, oldAttachmentId?: string): void;
  snapshots?: {
    backfill(only?: string[]): Promise<number>;
    rewriteChain(acct: string, targets: SenderHook[]): Promise<{ webhook_id: string; message_id: string }[]>;
    withLock<T>(fn: () => Promise<T> | T): Promise<T>;
  } | null;
  log?: (s: string) => void;
}

/** Errors that stop a job for good (retrying cannot help); everything else pauses it. */
const FATAL = new Set(["need_other_channel", "sha256_mismatch", "attachment_missing", "no_snapshots", "no_bot", "webhook_removed"]);

/**
 * Runs move/recover jobs one at a time. Each step commits to the database before the next, so a
 * crash or a Discord outage loses at most the blob in flight (its copy is posted again; the
 * orphan copy stays on Discord, harmless).
 */
export class ChannelMover {
  private running = false;
  readonly stats = { moved: 0, chains: 0, deleted: 0 };

  constructor(private readonly d: MoverDeps) {}

  get busy(): boolean {
    return this.running;
  }

  /** Run every due job; returns how many ended (done or failed). */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ended = 0;
    try {
      // Until nothing new is due: a job queued while this pass runs (API, CLI) starts right after it.
      const tried = new Set<number>();
      for (;;) {
        const j = this.d.store.dueJobs().find((x) => !tried.has(x.id));
        if (!j) break;
        tried.add(j.id);
        const st = await this.runJob(j);
        if (st === "done" || st === "failed") ended++;
      }
      return ended;
    } finally {
      this.running = false;
    }
  }

  private set(j: MoveJobRow, f: Partial<MoveJobRow>): void {
    const keys = Object.keys(f) as (keyof MoveJobRow)[];
    this.d.store.db.prepare(`UPDATE s_moves SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k] as never), this.d.now(), j.id);
  }

  private targets(j: MoveJobRow, acct: string): SenderHook[] {
    // hooksFor skips retired webhooks, and W is retired (move) or gone (recover).
    return this.d.hooks.hooksFor(acct).filter((h) => h.id !== j.webhook_id && h.alive !== false);
  }

  private movable(j: MoveJobRow, limit: number): BlobRowLike[] {
    const a = j.scope === POOL ? "" : " AND b.account_id = ?";
    return this.d.store.db
      .prepare(`SELECT b.* FROM s_blobs b LEFT JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND coalesce(u.state, 'open') NOT IN ${GARBAGE}${a} ORDER BY b.account_id, b.upload_id, b.idx LIMIT ?`)
      .all(...(j.scope === POOL ? [j.webhook_id, limit] : [j.webhook_id, j.scope, limit])) as unknown as BlobRowLike[];
  }

  private garbage(j: MoveJobRow): { account_id: string; upload_id: string }[] {
    const a = j.scope === POOL ? "" : " AND b.account_id = ?";
    return this.d.store.db
      .prepare(`SELECT DISTINCT b.account_id, b.upload_id FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.webhook_id = ? AND b.deleted_at IS NULL AND u.state IN ${GARBAGE}${a}`)
      .all(...(j.scope === POOL ? [j.webhook_id] : [j.webhook_id, j.scope])) as { account_id: string; upload_id: string }[];
  }

  /**
   * Accounts whose chain must be written anew before W can go: those with objects on W, plus chains
   * whose objects are not known (not walked, objs_ok 0 or 2) in this scope: they might have segments
   * on W, and a fresh chain from the database log costs little and needs nothing from the old one.
   */
  private chainsOn(j: MoveJobRow): string[] {
    if (j.kind !== "move") return [];
    const acct = j.scope === POOL ? undefined : j.scope;
    const unknown = (this.d.store.db.prepare(`SELECT account_id FROM s_snapshots WHERE objs_ok <> 1${acct ? " AND account_id = ?" : ""}`).all(...(acct ? [acct] : [])) as { account_id: string }[]).map((r) => r.account_id);
    return [...new Set([...this.d.store.critical(j.webhook_id, acct).accounts, ...unknown])].sort();
  }

  /** What still keeps W from leaving: live blobs, garbage blobs (move only: a removed webhook cannot delete), chains. */
  private remaining(j: MoveJobRow): number {
    if (j.kind === "recover") return this.movable(j, 1).length;
    return this.movable(j, 1).length + this.garbage(j).length + this.chainsOn(j).length;
  }

  private async runJob(j0: MoveJobRow): Promise<MoveJobRow["state"]> {
    let j = j0;
    const d = this.d;
    try {
      this.set(j, { state: "running", error: null });
      if (j.kind === "move") {
        const h = d.hooks.info(j.webhook_id);
        if (!h) {
          // Removed under the job (operator): nothing left to do here.
          this.set(j, { state: d.hooks.removedInfo(j.webhook_id)?.how === "moved" ? "done" : "failed", error: d.hooks.removedInfo(j.webhook_id)?.how === "moved" ? null : "webhook_removed" });
          return d.store.job(j.id)!.state;
        }
        if (!h.retired) d.hooks.setRetired(j.webhook_id, true);
      }
      // Chains from before s_snap_objs: index them first, or segments on W would be missed.
      if (j.kind === "move" && d.snapshots) await d.snapshots.backfill();
      let lastLeft = Infinity;
      for (;;) {
        await d.idleFor(j.webhook_id);
        // Refresh the totals: what is done + what is left now (puts that were in flight, a restart).
        j = d.store.job(j.id)!;
        const left = this.d.store.stats(j.webhook_id, j.scope === POOL ? undefined : j.scope);
        this.set(j, { total: j.done + left.blobs + (j.kind === "move" ? left.chainAccounts.length : 0), bytes_total: j.bytes_done + left.blobBytes + (j.kind === "move" ? left.chainBytes : 0) });
        // 1. blobs, in batches
        for (;;) {
          const rows = this.movable(j, 50);
          if (!rows.length) break;
          for (const b of rows) await this.moveBlob(j, b);
        }
        // 2. garbage of cancelled/abandoned uploads on W: delete it now (the cleanup would anyway)
        if (j.kind === "move") for (const g of this.garbage(j)) await d.deleteUpload(g.account_id, g.upload_id);
        // 3. snapshot chains that touch W: a fresh chain from the database log on the targets
        for (const acct of this.chainsOn(j)) {
          if (!d.snapshots) throw new ChannelError(409, "no_snapshots");
          const t = this.targets(j, acct);
          if (!t.length) throw new ChannelError(409, "need_other_channel");
          const bytes = Number((d.store.db.prepare("SELECT coalesce(sum(size), 0) AS s FROM s_snap_objs WHERE account_id = ?").get(acct) as { s: number }).s);
          const old = await d.snapshots.rewriteChain(acct, t);
          d.store.db.exec("BEGIN");
          try {
            for (const o of old) d.store.db.prepare("INSERT OR IGNORE INTO s_move_trash (job_id, webhook_id, message_id) VALUES (?, ?, ?)").run(j.id, o.webhook_id, o.message_id);
            d.store.db.prepare("UPDATE s_moves SET done = done + 1, bytes_done = bytes_done + ?, updated_at = ? WHERE id = ?").run(bytes, d.now(), j.id);
            d.store.db.exec("COMMIT");
          } catch (e) {
            d.store.db.exec("ROLLBACK");
            throw e;
          }
          this.stats.chains++;
        }
        await d.idleFor(j.webhook_id);
        const left2 = this.remaining(j);
        if (left2) {
          // Something landed meanwhile (a put that was in flight): another round. A round that
          // changed nothing (a delete that keeps failing) pauses the job instead of spinning.
          if (left2 >= lastLeft) throw new Error("no_progress");
          lastLeft = left2;
          continue;
        }
        // 4. Every copy is confirmed (Discord answered each post with the stored attachment), so the
        // old messages can go. Deleting them right away is consistent in e2ee/plain: the server's
        // chains have no bases that could point at blob placements (the server never sees the
        // tree), and the clients' old placements are answered through s_blob_alias.
        await this.deleteTrash(j);
        // 5. W leaves the instance, checked and done in one synchronous step under the snapshot
        // lock (no segment and no blob row can land on W between the check and the removal).
        const finish = (): boolean => {
          if (this.remaining(j)) return false;
          if (j.kind === "move") d.hooks.remove(j.scope, j.webhook_id, "moved");
          else d.hooks.markRemovedMoved(j.webhook_id);
          return true;
        };
        const finished = d.snapshots ? await d.snapshots.withLock(finish) : finish();
        if (finished) break;
      }
      this.set(j, { state: "done", error: null });
      return "done";
    } catch (e) {
      const code = e instanceof ChannelError ? e.code : (e as { code?: string }).code && FATAL.has(String((e as { code?: string }).code)) ? String((e as { code?: string }).code) : String((e as Error)?.message ?? e).slice(0, 200);
      const fatal = FATAL.has(code);
      d.log?.(`channel move ${j.webhook_id}: ${code}`);
      this.set(j, { state: fatal ? "failed" : "paused", error: code, retry_at: d.now() + MOVE_RETRY_MS });
      return fatal ? "failed" : "paused";
    }
  }

  private async moveBlob(j: MoveJobRow, b: BlobRowLike): Promise<void> {
    const d = this.d;
    const t = this.targets(j, b.account_id);
    if (!t.length) throw new ChannelError(409, "need_other_channel");
    const data = await d.readBlob(b);
    if (createHash("sha256").update(data).digest("hex") !== b.sha256) throw new ChannelError(409, "sha256_mismatch");
    const filename = `${randomBytes(16).toString("base64url")}${BLOB_EXT}`;
    const p = await d.post(t, data, filename);
    const db = d.store.db;
    db.exec("BEGIN");
    let ok = false;
    try {
      // Only if the row is still the one we copied (not deleted or replaced meanwhile).
      const u = db
        .prepare("UPDATE s_blobs SET webhook_id = ?, channel_id = ?, message_id = ?, attachment_id = ?, filename = ? WHERE account_id = ? AND upload_id = ? AND idx = ? AND message_id = ? AND deleted_at IS NULL")
        .run(p.locationId, p.channelId, p.messageId, p.attachmentId, filename, b.account_id, b.upload_id, b.idx, b.message_id);
      if (u.changes > 0) {
        db.prepare("INSERT INTO s_blob_alias (attachment_id, account_id, upload_id, idx, moved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(attachment_id) DO UPDATE SET account_id = excluded.account_id, upload_id = excluded.upload_id, idx = excluded.idx, moved_at = excluded.moved_at").run(
          b.attachment_id,
          b.account_id,
          b.upload_id,
          b.idx,
          d.now(),
        );
        // recover: the webhook is gone, its old message cannot be deleted (it stays on Discord, unread).
        if (j.kind === "move") db.prepare("INSERT OR IGNORE INTO s_move_trash (job_id, webhook_id, message_id) VALUES (?, ?, ?)").run(j.id, b.webhook_id, b.message_id);
        db.prepare("UPDATE s_moves SET done = done + 1, bytes_done = bytes_done + ?, updated_at = ? WHERE id = ?").run(b.size, d.now(), j.id);
        ok = true;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (!ok) {
      const h = d.hooks.hook(p.locationId);
      if (h) await d.deleteMessage(h, p.messageId).catch(() => {});
      return;
    }
    d.remember?.(p.attachmentId, p.url, b.attachment_id);
    this.stats.moved++;
  }

  private async deleteTrash(j: MoveJobRow): Promise<void> {
    const d = this.d;
    const rows = d.store.db.prepare("SELECT webhook_id, message_id FROM s_move_trash WHERE job_id = ?").all(j.id) as { webhook_id: string; message_id: string }[];
    for (const r of rows) {
      const h = d.hooks.hook(r.webhook_id);
      if (h) await d.deleteMessage(h, r.message_id); // 404 = already gone, fine (sender.delete)
      d.store.db.prepare("DELETE FROM s_move_trash WHERE job_id = ? AND message_id = ?").run(j.id, r.message_id);
      this.stats.deleted++;
    }
  }
}
