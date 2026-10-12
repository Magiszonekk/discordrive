// Background snapshots of the e2ee/plain instance (koncept §6.2, docs/stage3-modes.md §6).
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

import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MemoryIndexStore } from "@ddv4/sync-core";
import {
  accountKeyFromRaw,
  readLogChain,
  createPointerMessage,
  decideSnapshot,
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
import type { DiscordSender, SenderHook } from "./sender.js";

/** Key the server seals an account's snapshots with (never the account key). */
export function serverSnapshotKey(instanceKey: Buffer, accountId: string): AccountKey {
  return accountKeyFromRaw(new Uint8Array(instanceSubkey(instanceKey, `snapshot|${accountId}`)));
}

/** BlobIO over the instance webhooks (sender: paced per channel, Cloudflare fail-fast). */
export function serverBlobIO(hooks: InstanceHooks, sender: DiscordSender, accountId: string): BlobIO {
  const hook = (id: string): SenderHook => {
    const h = hooks.hook(id);
    if (!h) throw new Error(`webhook ${id} not in the instance`);
    return h;
  };
  return {
    post: async (d, f) => {
      const p = await sender.post(hooks.hooksFor(accountId), d, f);
      return { provider: "discord-webhook", locationId: p.locationId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId };
    },
    fetch: async (p) => {
      const atts = await sender.attachments(hook(p.locationId), p.messageId);
      const a = atts.find((x) => x.id === p.attachmentId);
      if (!a) throw new Error("attachment missing");
      return sender.transport.fetchCdn(a.url);
    },
    remove: async (r) => sender.delete(hook(r.webhookId), r.messageId),
    hook,
    transport: sender.transport,
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
  readonly stats = { segments: 0, errors: 0 };
  lastError: string | null = null;

  constructor(readonly o: SnapshotsExtensionOptions) {}

  init(srv: DdnServer): void {
    this.srv = srv;
    this.db = srv.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS s_snapshots (
      account_id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, message_id TEXT NOT NULL,
      to_seq INTEGER NOT NULL DEFAULT 0, written_at INTEGER NOT NULL DEFAULT 0)`);
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
    try {
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

  private async segment(acct: string, head: number): Promise<Pointer> {
    const key = serverSnapshotKey(this.o.instanceKey, acct);
    const io = serverBlobIO(this.o.hooks(), this.o.sender, acct);
    let loc = this.location(acct);
    if (!loc) {
      const hooks = this.o.hooks().hooksFor(acct).filter((h) => h.alive !== false);
      if (!hooks.length) throw new Error("need_channel");
      loc = await createPointerMessage(io, key, acct, hooks[0]!);
      this.db.prepare("INSERT INTO s_snapshots (account_id, webhook_id, message_id) VALUES (?, ?, ?)").run(acct, loc.webhookId, loc.messageId);
      this.exportLocations();
    }
    // writeSnapshot reads the head from a store; the server has no tree, only the head matters for a segment.
    const store = new MemoryIndexStore();
    store.setMeta({ ...store.getMeta(), headSeq: head });
    const log = { read: async (after: number, limit?: number) => this.srv.logRead(acct, after, limit ?? 1000), submit: async () => ({ status: "rules_version_rejected" }) as never, renewLease: async () => false, releaseLease: async () => {} };
    const r = await writeSnapshot({ io, key, accountId: acct, pointer: loc, log, store, now: () => this.srv.clock() }, "segment");
    const p = r.written === "written" ? r.pointer : await readPointer(io, key, acct, loc);
    this.db.prepare("UPDATE s_snapshots SET to_seq = ?, written_at = ? WHERE account_id = ?").run(p.toSeq, this.srv.clock(), acct);
    if (p.toSeq >= head) this.pending.delete(acct);
    this.stats.segments++;
    return p;
  }
}

/**
 * Rebuild one account's encrypted log from Discord after the server database is gone
 * (operator path, docs/stage3-modes.md §6): instance key + webhooks + pointer location.
 */
export async function rebuildAccountLog(instanceKey: Buffer, hooks: InstanceHooks, sender: DiscordSender, accountId: string, loc: PointerLocation): Promise<EncryptedEntry[]> {
  const { entries } = await readLogChain(serverBlobIO(hooks, sender, accountId), serverSnapshotKey(instanceKey, accountId), accountId, loc);
  if (entries.length && entries[0]!.seq !== 1) throw new Error("chain does not start at seq 1");
  return entries;
}
