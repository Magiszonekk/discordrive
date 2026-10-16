// Background snapshots of the e2ee/plain instance.
//
// The server writes, for every account with new log entries, the same segment chain the
// metadata-only client writes (snapshots.ts: writeSnapshot, pointer message edited in place),
// without any browser tab open:
//  - segment after 1 min of silence, at the latest 5 min after the first new entry
//    (max loss ≤ 5 min), only when there are changes;
//  - sealed with HKDF(instance key, "snapshot|<account>") instead of the account key (the
//    server does not have the account key); entries keep their op payloads sealed with the
//    account key, so the server still never reads operations in e2ee;
//  - no bases in e2ee: a base is the decrypted tree, which the server does not know. The chain
//    starts at seq 1 and is never pruned, so it is the whole log: point-in-time restore works.
// Pointer locations are kept in the database AND in <dataDir>/snapshots.json, so after losing
// the database an operator can rebuild every account's log from Discord with the instance key,
// the pool webhooks and that file (readLogChain + Sequencer initialLog; test in snapshots test).
//
// Removing channels: a webhook holding an
// account's pointer message or a segment of its chain is "critical". s_snap_objs records where
// every object of a chain lies (written on every segment; chains from before it are walked once,
// backfillSnapshotObjects). New segments go only to the pointer's webhook, so an account's chain
// normally sits on ONE channel. Moving a critical channel writes a FRESH chain from the database
// log (rewriteChain: new pointer + segments of <= 2000 entries) instead of copying old objects:
// the server has the whole log, and e2ee has no bases that could point at old messages.

import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MemoryIndexStore } from "@ddv4/sync-core";
import type { DatabaseSync as Db } from "node:sqlite";
import {
  accountKeyFromRaw,
  readLogChain,
  createPointerMessage,
  decideSnapshot,
  discordSlot,
  isDiscordPlacement,
  emptyPointer,
  readPointer,
  writeSnapshot,
  type AccountKey,
  type BlobIO,
  type EncryptedEntry,
  type Pointer,
  type PointerLocation,
} from "@ddv4/metadata-client";
import type { DdnServer, ServerExtension } from "@ddv4/metadata-client/node";
import { instanceSubkey, type InstanceHooks } from "./instance-hooks.js";
import { DiscordUnavailableError, type DiscordSender, type SenderHook } from "./sender.js";

/** Key the server seals an account's snapshots with (never the account key). */
export function serverSnapshotKey(instanceKey: Buffer, accountId: string): AccountKey {
  return accountKeyFromRaw(new Uint8Array(instanceSubkey(instanceKey, `snapshot|${accountId}`)));
}

/** A failed background walk of an old chain (Discord down) is retried after this long. */
export const BACKFILL_RETRY_MS = 10 * 60_000;

/** Most entries in one segment of a rewritten chain (a moved channel's chain is written anew). */
export const REWRITE_SEGMENT_ENTRIES = 2000;

/** Tables of the server snapshots (also opened by the `discordrive channels` CLI without a server). */
export function snapshotTables(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS s_snapshots (
    account_id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, message_id TEXT NOT NULL,
    to_seq INTEGER NOT NULL DEFAULT 0, written_at INTEGER NOT NULL DEFAULT 0)`);
  // objs_ok: 1 = s_snap_objs lists every object of this chain (new chains: from the start; older ones:
  // after the backfill walk), 0 = not walked yet, 2 = the walk failed (unreadable chain; pointer known only).
  if (!(db.prepare("PRAGMA table_info(s_snapshots)").all() as { name: string }[]).some((c) => c.name === "objs_ok")) db.exec("ALTER TABLE s_snapshots ADD COLUMN objs_ok INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS s_snap_objs (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, webhook_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, message_id));
    CREATE INDEX IF NOT EXISTS s_snap_objs_hook ON s_snap_objs(webhook_id);`);
}

export interface SnapObj {
  account_id: string;
  message_id: string;
  webhook_id: string;
  attachment_id: string;
  kind: "pointer" | "segment";
  size: number;
}

function recordObj(db: Db, o: SnapObj): void {
  db.prepare("INSERT INTO s_snap_objs (account_id, message_id, webhook_id, attachment_id, kind, size) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, message_id) DO NOTHING").run(
    o.account_id,
    o.message_id,
    o.webhook_id,
    o.attachment_id,
    o.kind,
    o.size,
  );
}

/**
 * Walk the chains written before s_snap_objs existed (once per account) and record where every
 * object lies. Needs Discord reads only (pointer GET + one CDN read per segment). Accounts whose
 * pointer webhook is gone stay unindexed (their chain cannot be read anyway). Returns how many
 * accounts were indexed.
 */
export async function backfillSnapshotObjects(db: Db, hooks: InstanceHooks, sender: DiscordSender, instanceKey: Buffer, only?: string[], log?: (s: string) => void): Promise<number> {
  const rows = (db.prepare("SELECT account_id, webhook_id, message_id FROM s_snapshots WHERE objs_ok = 0 AND webhook_id IN (SELECT id FROM inst_hooks)").all() as { account_id: string; webhook_id: string; message_id: string }[]).filter(
    (r) => !only || only.includes(r.account_id),
  );
  let n = 0;
  for (const r of rows) {
    if (!hooks.hook(r.webhook_id)) continue;
    const base = serverBlobIO(hooks, sender, r.account_id);
    const seen: SnapObj[] = [];
    const io: BlobIO = {
      ...base,
      fetch: async (p) => {
        const d = await base.fetch(p);
        seen.push({ account_id: r.account_id, message_id: p.messageId, webhook_id: p.locationId, attachment_id: p.attachmentId, kind: "segment", size: d.byteLength });
        return d;
      },
    };
    try {
      await readLogChain(io, serverSnapshotKey(instanceKey, r.account_id), r.account_id, { webhookId: r.webhook_id, messageId: r.message_id });
    } catch (e) {
      // Unreadable chain (deleted messages, wrong key): it cannot rebuild anything anyway. Mark it
      // (objs_ok = 2) so it does not block retiring/removing forever; a move rewrites it from the log.
      log?.(`snapshot index of ${r.account_id}: ${(e as Error).message}`);
      const transient = e instanceof DiscordUnavailableError || e instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|timeout|HTTP 5\d\d|HTTP 429/i.test(String((e as Error)?.message));
      if (!transient) {
        db.prepare("UPDATE s_snapshots SET objs_ok = 2 WHERE account_id = ? AND message_id = ?").run(r.account_id, r.message_id);
        recordObj(db, { account_id: r.account_id, message_id: r.message_id, webhook_id: r.webhook_id, attachment_id: "", kind: "pointer", size: 0 });
      }
      continue;
    }
    db.exec("BEGIN");
    try {
      recordObj(db, { account_id: r.account_id, message_id: r.message_id, webhook_id: r.webhook_id, attachment_id: "", kind: "pointer", size: 0 });
      for (const o of seen) recordObj(db, o);
      db.prepare("UPDATE s_snapshots SET objs_ok = 1 WHERE account_id = ? AND message_id = ?").run(r.account_id, r.message_id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    n++;
  }
  return n;
}

/** BlobIO over the instance webhooks (sender: paced per channel, Cloudflare fail-fast). `targets`: where posts go (default: the account's channels). */
export function serverBlobIO(hooks: InstanceHooks, sender: DiscordSender, accountId: string, targets?: () => SenderHook[]): BlobIO {
  const hook = (id: string): SenderHook => {
    const h = hooks.hook(id);
    if (!h) throw new Error(`webhook ${id} not in the instance`);
    return h;
  };
  return {
    post: async (d, f) => {
      const p = await sender.post(targets ? targets() : hooks.hooksFor(accountId), d, f);
      return { provider: "discord-webhook", locationId: p.locationId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId };
    },
    fetch: async (p) => {
      if (!isDiscordPlacement(p)) throw new Error(`not a Discord placement: ${p.provider}`);
      const atts = await sender.attachments(hook(p.locationId), p.messageId);
      const a = atts.find((x) => x.id === p.attachmentId);
      if (!a) throw new Error("attachment missing");
      return sender.transport.fetchCdn(a.url);
    },
    remove: async (r) => sender.delete(hook(r.webhookId), r.messageId),
    slot: (id) => discordSlot(sender.transport, hook(id)),
    partSize: 10 * 1024 * 1024,
  };
}

export interface SnapshotsExtensionOptions {
  instanceKey: Buffer;
  hooks: () => InstanceHooks;
  sender: DiscordSender;
  /** Where snapshots.json goes (operator's copy of the pointer locations). */
  dataDir?: string;
  /** Background tick (ms); 0 = no timer (tests call tick()). */
  tickMs?: number;
  log?: (s: string) => void;
}

export class SnapshotsExtension implements ServerExtension {
  readonly name = "server-snapshots";
  private srv!: DdnServer;
  private db!: DatabaseSync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Server time of the first entry not covered yet, per account (from onAppend; rebuilt from the log on start). */
  private readonly pending = new Map<string, { first: number; last: number }>();
  /** Last background try to index old chains (retried every BACKFILL_RETRY_MS while some are left, not every tick). */
  private backfillAt = -Infinity;
  readonly stats = { segments: 0, errors: 0, rewritten: 0 };
  lastError: string | null = null;

  constructor(readonly o: SnapshotsExtensionOptions) {}

  init(srv: DdnServer): void {
    this.srv = srv;
    this.db = srv.db;
    snapshotTables(this.db);
    if (this.o.tickMs !== 0) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.o.log?.(`snapshots: ${(e as Error).message}`)), this.o.tickMs ?? 15_000);
      this.timer.unref?.();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health(): Record<string, unknown> {
    return { snapshots: { by: "server", segments: this.stats.segments, lastError: this.lastError } };
  }

  onAppend(accountId: string, entry: EncryptedEntry): void {
    const p = this.pending.get(accountId);
    if (p) p.last = entry.serverTime;
    else this.pending.set(accountId, { first: entry.serverTime, last: entry.serverTime });
  }

  private row(accountId: string): { webhook_id: string; message_id: string; to_seq: number } | undefined {
    return this.db.prepare("SELECT webhook_id, message_id, to_seq FROM s_snapshots WHERE account_id = ?").get(accountId) as never;
  }

  location(accountId: string): PointerLocation | null {
    const r = this.row(accountId);
    return r ? { webhookId: r.webhook_id, messageId: r.message_id } : null;
  }

  /** The database handle (channels: which webhooks hold what). */
  get database(): Db {
    return this.db;
  }

  private exportLocations(): void {
    if (!this.o.dataDir) return;
    const rows = this.db.prepare("SELECT account_id, webhook_id, message_id, to_seq FROM s_snapshots ORDER BY account_id").all();
    const p = join(this.o.dataDir, "snapshots.json");
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ v: 1, note: "pointer messages of the server-written log chains (one per account); with instance.key and the pool webhooks they rebuild each account's log", accounts: rows }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p);
  }

  /** Write a segment for every account that is due (or all with changes when forced). */
  async tick(force = false): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let written = 0;
    const now0 = () => this.srv.clock();
    try {
      // Chains from before s_snap_objs: index them once (critical-channel detection needs it).
      if (now0() - this.backfillAt >= BACKFILL_RETRY_MS && (this.db.prepare("SELECT 1 FROM s_snapshots WHERE objs_ok = 0 LIMIT 1").get() as unknown)) {
        this.backfillAt = now0();
        await backfillSnapshotObjects(this.db, this.o.hooks(), this.o.sender, this.o.instanceKey, undefined, this.o.log).catch((e) => this.o.log?.(`snapshot index: ${(e as Error).message}`));
      }
      const now = this.srv.clock();
      for (const acct of this.srv.accountsWithLog()) {
        const head = this.srv.logHead(acct);
        const r = this.row(acct);
        if (head <= (r?.to_seq ?? 0)) {
          this.pending.delete(acct);
          continue;
        }
        let pend = this.pending.get(acct);
        if (!pend) {
          // After a restart: times from the log itself.
          const from = this.srv.logRead(acct, r?.to_seq ?? 0, 1)[0];
          const last = this.srv.logRead(acct, head - 1, 1)[0];
          pend = { first: from?.serverTime ?? now, last: last?.serverTime ?? now };
          this.pending.set(acct, pend);
        }
        const toSeq = r?.to_seq ?? 0;
        const decision = decideSnapshot(now, head, { ...emptyPointer(), toSeq }, { lastEntryAt: pend.last, firstPendingAt: pend.first }, { unmetered: false, force });
        if (decision === "none") continue;
        try {
          await this.segment(acct, head);
          written++;
        } catch (e) {
          this.stats.errors++;
          this.lastError = String((e as Error).message ?? e);
          this.o.log?.(`snapshot of ${acct}: ${this.lastError}`);
        }
      }
      if (written) this.exportLocations();
      return written;
    } finally {
      this.running = false;
    }
  }

  /** Index chains written before s_snap_objs existed (all accounts, or `only`). */
  async backfill(only?: string[]): Promise<number> {
    await this.lock();
    try {
      return await backfillSnapshotObjects(this.db, this.o.hooks(), this.o.sender, this.o.instanceKey, only, this.o.log);
    } finally {
      this.running = false;
    }
  }


  /**
   * Segments go to the pointer's webhook while it takes posts (fewer critical channels: one chain
   * = one webhook); a retired, dead or removed pointer webhook falls back to the account's channels.
   */
  private segmentTargets(acct: string, loc: PointerLocation): () => SenderHook[] {
    return () => {
      const h = this.o.hooks().hook(loc.webhookId);
      return h && !h.retired && h.alive !== false ? [h] : this.o.hooks().hooksFor(acct);
    };
  }

  private async lock(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 20));
    this.running = true;
  }

  /** Run `fn` while no segment is being written (removing a webhook a segment could be going to). */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.lock();
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }

  /**
   * Write a fresh chain of `acct` from the database log on `targets` (pointer message + segments of
   * at most REWRITE_SEGMENT_ENTRIES entries, each linked to the previous), switch s_snapshots and
   * snapshots.json to it, and return the objects of the OLD chain: the caller deletes them once the
   * whole move succeeded. Runs under the same lock as tick(), so no segment is written meanwhile.
   */
  async rewriteChain(acct: string, targets: SenderHook[]): Promise<SnapObj[]> {
    await this.lock();
    try {
      const live = targets.filter((h) => h.alive !== false);
      if (!live.length) throw new Error("need_channel");
      const db = this.db;
      const old = db.prepare("SELECT * FROM s_snap_objs WHERE account_id = ?").all(acct) as unknown as SnapObj[];
      const prevLoc = this.location(acct);
      if (prevLoc && !old.some((o) => o.message_id === prevLoc.messageId)) old.push({ account_id: acct, message_id: prevLoc.messageId, webhook_id: prevLoc.webhookId, attachment_id: "", kind: "pointer", size: 0 });
      const key = serverSnapshotKey(this.o.instanceKey, acct);
      const target = this.o.sender.pick(live);
      const io = serverBlobIO(this.o.hooks(), this.o.sender, acct, () => [target]);
      const loc = await createPointerMessage(io, key, acct, target);
      const fresh: SnapObj[] = [{ account_id: acct, message_id: loc.messageId, webhook_id: loc.webhookId, attachment_id: "", kind: "pointer", size: 0 }];
      const head = this.srv.logHead(acct);
      const log = { read: async (after: number, limit?: number) => this.srv.logRead(acct, after, limit ?? 1000), submit: async () => ({ status: "rules_version_rejected" }) as never, renewLease: async () => false, releaseLease: async () => {} };
      let toSeq = 0;
      try {
        while (toSeq < head) {
          const store = new MemoryIndexStore();
          store.setMeta({ ...store.getMeta(), headSeq: Math.min(head, toSeq + REWRITE_SEGMENT_ENTRIES) });
          const r = await writeSnapshot({ io, key, accountId: acct, pointer: loc, log, store, now: () => this.srv.clock() }, "segment");
          if (r.written !== "written" || !r.pointer.lastSegment) throw new Error("chain rewrite: segment not written");
          const sg = r.pointer.lastSegment;
          fresh.push({ account_id: acct, message_id: sg.messageId, webhook_id: sg.webhookId, attachment_id: sg.attachmentId, kind: "segment", size: sg.size });
          toSeq = r.pointer.toSeq;
        }
      } catch (e) {
        // Half-written new chain: drop it, the old one still stands.
        for (const o of fresh) await this.o.sender.delete(this.o.hooks().hook(o.webhook_id) ?? target, o.message_id).catch(() => {});
        throw e;
      }
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO s_snapshots (account_id, webhook_id, message_id, to_seq, written_at, objs_ok) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET webhook_id = excluded.webhook_id, message_id = excluded.message_id, to_seq = excluded.to_seq, written_at = excluded.written_at, objs_ok = 1",
        ).run(acct, loc.webhookId, loc.messageId, toSeq, this.srv.clock());
        db.prepare("DELETE FROM s_snap_objs WHERE account_id = ?").run(acct);
        for (const o of fresh) recordObj(db, o);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      this.exportLocations();
      this.stats.rewritten++;
      return old;
    } finally {
      this.running = false;
    }
  }

  private async segment(acct: string, head: number): Promise<Pointer> {
    const key = serverSnapshotKey(this.o.instanceKey, acct);
    let loc = this.location(acct);
    if (!loc) {
      const hooks = this.o.hooks().hooksFor(acct).filter((h) => h.alive !== false);
      if (!hooks.length) throw new Error("need_channel");
      loc = await createPointerMessage(serverBlobIO(this.o.hooks(), this.o.sender, acct), key, acct, hooks[0]!);
      this.db.prepare("INSERT INTO s_snapshots (account_id, webhook_id, message_id, objs_ok) VALUES (?, ?, ?, 1)").run(acct, loc.webhookId, loc.messageId);
      recordObj(this.db, { account_id: acct, message_id: loc.messageId, webhook_id: loc.webhookId, attachment_id: "", kind: "pointer", size: 0 });
      this.exportLocations();
    }
    const io = serverBlobIO(this.o.hooks(), this.o.sender, acct, this.segmentTargets(acct, loc));
    // writeSnapshot reads the head from a store; the server has no tree, only the head matters for a segment.
    const store = new MemoryIndexStore();
    store.setMeta({ ...store.getMeta(), headSeq: head });
    const log = { read: async (after: number, limit?: number) => this.srv.logRead(acct, after, limit ?? 1000), submit: async () => ({ status: "rules_version_rejected" }) as never, renewLease: async () => false, releaseLease: async () => {} };
    const r = await writeSnapshot({ io, key, accountId: acct, pointer: loc, log, store, now: () => this.srv.clock() }, "segment");
    if (r.written === "written" && r.kind !== "none" && r.pointer.lastSegment) {
      const sg = r.pointer.lastSegment;
      recordObj(this.db, { account_id: acct, message_id: sg.messageId, webhook_id: sg.webhookId, attachment_id: sg.attachmentId, kind: "segment", size: sg.size });
    }
    const p = r.written === "written" ? r.pointer : await readPointer(io, key, acct, loc);
    this.db.prepare("UPDATE s_snapshots SET to_seq = ?, written_at = ? WHERE account_id = ?").run(p.toSeq, this.srv.clock(), acct);
    if (p.toSeq >= head) this.pending.delete(acct);
    this.stats.segments++;
    return p;
  }
}

/**
 * Rebuild one account's encrypted log from Discord after the server database is gone
 * (operator path): instance key + webhooks + pointer location.
 */
export async function rebuildAccountLog(instanceKey: Buffer, hooks: InstanceHooks, sender: DiscordSender, accountId: string, loc: PointerLocation): Promise<EncryptedEntry[]> {
  const { entries } = await readLogChain(serverBlobIO(hooks, sender, accountId), serverSnapshotKey(instanceKey, accountId), accountId, loc);
  if (entries.length && entries[0]!.seq !== 1) throw new Error("chain does not start at seq 1");
  return entries;
}
