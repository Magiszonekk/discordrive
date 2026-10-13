// Instance webhooks for the e2ee and plain modes (docs/stage3-modes.md §3).
//
// One table for both kinds:
//   scope "pool"      the instance pool from `discordrive setup` (like discordrive's WEBHOOK_1..N);
//   scope <accountId> channels an account added in Settings -> Channels. An account with its
//                     own channels posts only there; without them it uses the pool.
// URLs are tokens that can delete messages: sealed with AES-256-GCM under a key derived from
// the instance key (<dataDir>/instance.key, a separate 0600 file), AAD = webhook ID + scope,
// so a copy of the database alone gives no webhooks and a sealed URL cannot be moved to
// another account. Nothing here ever returns a URL to an API caller.
//
// Removing a channel (zlecenie 2026-10-13-webhooki p. 1): a webhook can be `retired` (no new
// blobs go there, it is still read) and a removed one leaves a row in inst_hooks_removed
// (scope, label, when, how: "moved" = its data was moved off first, "removed" = removed anyway).
// Files with blobs on a webhook that is no longer here are unavailable; that is computed from
// s_blobs, never stored, so pasting the same webhook again (same ID) brings them back at once.
// Other processes (the `discordrive channels` CLI) may change the table under a running server:
// every read checks PRAGMA data_version (changes only on another connection's commit) and reloads.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parseWebhookUrl, type WebhookTransport } from "@ddv4/metadata-client";
import type { SenderHook } from "./sender.js";

export const POOL = "pool";
export const INSTANCE_KEY_FILE = "instance.key";
export const MAX_ACCOUNT_CHANNELS = 10;

/** Read the instance key, creating it (32 random bytes, 0600) on first use. */
export function loadInstanceKey(path: string, create = true): Buffer {
  if (existsSync(path)) {
    const k = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (k.byteLength !== 32) throw new Error(`${path}: not a 32-byte key`);
    return k;
  }
  if (!create) throw new Error(`${path}: missing (the instance key; without it the stored webhooks cannot be read)`);
  const k = randomBytes(32);
  writeFileSync(path, k.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return k;
}

/** Subkey of the instance key for one purpose (HKDF-SHA256). */
export function instanceSubkey(instanceKey: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", instanceKey, Buffer.alloc(0), `ddn-instance-${label}-v1`, 32));
}

function seal(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}

function unseal(key: Buffer, sealed: string, aad: string): string {
  const b = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8");
}

export interface HookInfo {
  id: string;
  channelId: string;
  label: string;
  scope: string;
  alive: boolean;
  /** Gets no new blobs; still read (option 1 of removing a channel). */
  retired: boolean;
  createdAt: number;
}

export interface RemovedHook {
  id: string;
  scope: string;
  channelId: string;
  label: string;
  removedAt: number;
  how: "moved" | "removed";
}

export type CachedHook = SenderHook & { scope: string; retired: boolean };

export class InstanceHooks {
  private readonly key: Buffer;
  private cache = new Map<string, CachedHook>();
  private dataVersion = -1;

  constructor(
    private readonly db: DatabaseSync,
    instanceKey: Buffer,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.key = instanceSubkey(instanceKey, "hooks");
    db.exec(`CREATE TABLE IF NOT EXISTS inst_hooks (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, channel_id TEXT NOT NULL, label TEXT NOT NULL,
      url_sealed TEXT NOT NULL, alive INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS inst_hooks_scope ON inst_hooks(scope)");
    // Databases from before retiring existed: add the column in place.
    if (!(db.prepare("PRAGMA table_info(inst_hooks)").all() as { name: string }[]).some((c) => c.name === "retired")) db.exec("ALTER TABLE inst_hooks ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS inst_hooks_removed (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, channel_id TEXT NOT NULL, label TEXT NOT NULL,
      removed_at INTEGER NOT NULL, how TEXT NOT NULL)`);
    this.reload();
  }

  /** Another connection (the CLI) committed since the last load: read the table again. */
  private sync(): void {
    const v = Number((this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
    if (v !== this.dataVersion) this.reload();
  }

  private aad(id: string, scope: string): string {
    return `ddn-hook-v1|${id}|${scope}`;
  }

  /** Re-read the table (setup may have changed the pool). Unreadable rows (wrong key) throw. */
  reload(): void {
    this.dataVersion = Number((this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
    const rows = this.db.prepare("SELECT id, scope, channel_id, url_sealed, alive, retired FROM inst_hooks").all() as {
      id: string;
      scope: string;
      channel_id: string;
      url_sealed: string;
      alive: number;
      retired: number;
    }[];
    const next = new Map<string, CachedHook>();
    for (const r of rows) {
      let url: string;
      try {
        url = unseal(this.key, r.url_sealed, this.aad(r.id, r.scope));
      } catch {
        throw new Error("stored webhooks do not open with this instance key (instance.key replaced?)");
      }
      const prev = this.cache.get(r.id);
      next.set(r.id, { id: r.id, url, channelId: r.channel_id, scope: r.scope, alive: prev?.alive ?? r.alive === 1, retired: r.retired === 1 });
    }
    this.cache = next;
  }

  /** Validate a URL with Discord (GET webhook: no message is sent) and store it under `scope`. */
  async add(scope: string, url: string, transport: WebhookTransport, label = ""): Promise<HookInfo> {
    const ref = parseWebhookUrl(url);
    const info = await transport.inspectWebhook(ref);
    this.sync();
    if (scope !== POOL && this.list(scope).length >= MAX_ACCOUNT_CHANNELS && !this.cache.has(ref.id)) throw new Error("too_many_channels");
    const owner = this.cache.get(ref.id);
    if (owner && owner.scope !== scope) throw new Error("webhook_in_use");
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO inst_hooks (id, scope, channel_id, label, url_sealed, alive, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, label = excluded.label, url_sealed = excluded.url_sealed, alive = 1`,
      )
      .run(ref.id, scope, info.channelId, (label || info.name || "").slice(0, 80), seal(this.key, ref.url, this.aad(ref.id, scope)), at);
    // Pasted again after a removal: its blobs are readable again (unavailability is computed, not stored).
    this.db.prepare("DELETE FROM inst_hooks_removed WHERE id = ? AND scope = ?").run(ref.id, scope);
    this.reload();
    return this.info(ref.id)!;
  }

  /** Take a webhook out of the instance; remembered as removed (`how`) for the account's list. */
  remove(scope: string, id: string, how: "moved" | "removed" = "removed"): boolean {
    const r = this.db.prepare("SELECT channel_id, label FROM inst_hooks WHERE id = ? AND scope = ?").get(id, scope) as { channel_id: string; label: string } | undefined;
    if (!r) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM inst_hooks WHERE id = ? AND scope = ?").run(id, scope);
      this.db
        .prepare("INSERT INTO inst_hooks_removed (id, scope, channel_id, label, removed_at, how) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, channel_id = excluded.channel_id, label = excluded.label, removed_at = excluded.removed_at, how = excluded.how")
        .run(id, scope, r.channel_id, r.label, this.now(), how);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.reload();
    return true;
  }

  /** Webhooks removed from a scope, newest first (still listed after a re-paste? no: add() clears the row). */
  removed(scope: string): RemovedHook[] {
    return (this.db.prepare("SELECT id, scope, channel_id, label, removed_at, how FROM inst_hooks_removed WHERE scope = ? ORDER BY removed_at DESC, id").all(scope) as {
      id: string;
      scope: string;
      channel_id: string;
      label: string;
      removed_at: number;
      how: string;
    }[]).map((r) => ({ id: r.id, scope: r.scope, channelId: r.channel_id, label: r.label, removedAt: r.removed_at, how: r.how === "moved" ? "moved" : "removed" }));
  }

  /** A removed webhook by ID (any scope). */
  removedInfo(id: string): RemovedHook | null {
    const r = this.db.prepare("SELECT scope FROM inst_hooks_removed WHERE id = ?").get(id) as { scope: string } | undefined;
    return r ? (this.removed(r.scope).find((x) => x.id === id) ?? null) : null;
  }

  /** After a bot recovery moved everything off a removed webhook. */
  markRemovedMoved(id: string): void {
    this.db.prepare("UPDATE inst_hooks_removed SET how = 'moved' WHERE id = ?").run(id);
  }

  setRetired(id: string, retired: boolean): void {
    this.db.prepare("UPDATE inst_hooks SET retired = ? WHERE id = ?").run(retired ? 1 : 0, id);
    this.reload();
  }

  info(id: string): HookInfo | null {
    this.sync();
    const r = this.db.prepare("SELECT id, scope, channel_id, label, alive, retired, created_at FROM inst_hooks WHERE id = ?").get(id) as
      | { id: string; scope: string; channel_id: string; label: string; alive: number; retired: number; created_at: number }
      | undefined;
    if (!r) return null;
    return { id: r.id, scope: r.scope, channelId: r.channel_id, label: r.label, alive: this.cache.get(r.id)?.alive ?? r.alive === 1, retired: r.retired === 1, createdAt: r.created_at };
  }

  /** Public info (no URLs) of one scope. */
  list(scope: string): HookInfo[] {
    return (this.db.prepare("SELECT id FROM inst_hooks WHERE scope = ? ORDER BY created_at, id").all(scope) as { id: string }[]).map((r) => this.info(r.id)!);
  }

  /**
   * Where an account's blobs go: its own channels that are not retired, else the pool's
   * (an account whose own channels are all retired or gone falls back to the pool).
   */
  hooksFor(accountId: string): SenderHook[] {
    this.sync();
    const own = [...this.cache.values()].filter((h) => h.scope === accountId && !h.retired);
    return own.length ? own : [...this.cache.values()].filter((h) => h.scope === POOL && !h.retired);
  }

  /** A stored webhook by ID (any scope, retired too), with its URL: for reading/deleting what it posted. */
  hook(id: string): CachedHook | null {
    this.sync();
    return this.cache.get(id) ?? null;
  }

  all(): CachedHook[] {
    this.sync();
    return [...this.cache.values()];
  }

  /** Persist a health-check result. */
  setAlive(id: string, alive: boolean): void {
    this.db.prepare("UPDATE inst_hooks SET alive = ? WHERE id = ?").run(alive ? 1 : 0, id);
    const h = this.cache.get(id);
    if (h) h.alive = alive;
  }
}
