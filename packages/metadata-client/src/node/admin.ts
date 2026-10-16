// Instance administration: accounts, invite codes, the sign-up policy and the administrative log.
//
// Who may administer: the operator (shell access to the server, `discordrive accounts …`) and
// accounts with the admin flag. The flag is set only from the server (`accounts admin <id> on`,
// or by setup for the first account created on the instance); an admin may then grant it to
// others from the web app. The server checks the flag on every /v1/admin call.
//
// What an admin sees is what the server already stores: account and device IDs, times, sizes,
// the invite note, the admin/blocked flags. Never file names, the tree or (metadata only) the
// webhooks: those are sealed with the account key the server does not have.
//
// Blocking: the account cannot sign in, sync, pair or get notifications; its sessions end at once
// (open websockets are closed). Its data stays. Deleting: the account's rows on the server go at
// once; in e2ee/plain its pieces on Discord are deleted afterwards by the running server, in the
// background, resumable (`account_deletions`). Metadata only: the files live on the user's own
// Discord and are never touched (the user can restore the account from the rescue kit elsewhere).
//
// Every change is written to `admin_log` (who, what, when). The operator CLI writes as "operator".

import type { DatabaseSync } from "node:sqlite";
import { authTables } from "./auth.js";
import { inviteTables } from "./invites.js";

export type SignupPolicy = "open" | "invite" | "closed";
export const SIGNUP_POLICIES: readonly SignupPolicy[] = ["invite", "open", "closed"];
export const OPERATOR = "operator";

export interface AccountSummary {
  accountId: string;
  createdAt: number;
  /** Last sign-in or request of any of its devices (null: never since this was recorded). */
  lastSeenAt: number | null;
  devices: number;
  /** Bytes the server keeps for the account: operation log, webhook vault, share links. */
  serverBytes: number;
  /** e2ee/plain: bytes of the account on the instance's Discord channels; null in metadata only. */
  poolBytes: number | null;
  state: "active" | "blocked";
  blockedAt: number | null;
  blockedReason: string | null;
  /** Note of the invite code it was created with (null: no code, e.g. open sign-up). */
  inviteNote: string | null;
  admin: boolean;
}

export interface AdminDevice {
  deviceId: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** "create", "rescue" or the device that paired it. */
  addedBy: string;
}

export interface DeletionStatus {
  accountId: string;
  requestedAt: number;
  by: string;
  state: "pending" | "running" | "done" | "failed";
  /** Pieces on Discord to delete (blobs + snapshot objects) and how many are gone. */
  total: number;
  done: number;
  error: string | null;
  updatedAt: number;
  finishedAt: number | null;
}

export interface AdminLogEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "AdminError";
  }
}

const has = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Tables of the administration (and the ones it reads), safe on any database of an instance. */
export function adminTables(db: DatabaseSync): void {
  authTables(db);
  inviteTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS admin_log_action ON admin_log(action, id);
    CREATE TABLE IF NOT EXISTS account_deletions (
      account_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, by TEXT NOT NULL, state TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, error TEXT,
      updated_at INTEGER NOT NULL, finished_at INTEGER);
  `);
}

/** Server-side rows of one account, by table (deleted together with the account). */
const ACCOUNT_TABLES: [table: string, column: string][] = [
  ["log", "account_id"],
  ["vault", "account_id"],
  ["gc_runs", "account_id"],
  ["gc_done", "account_id"],
  ["shares", "account_id"],
  ["password_keys", "account_id"],
  ["password_fails", "account_id"],
  ["sessions", "account_id"],
  ["devices", "account_id"],
  ["accounts", "id"],
];

export class AdminStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    adminTables(db);
  }

  // --- log

  log(actor: string, action: string, target = "", detail: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO admin_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(this.now(), actor, action, target, JSON.stringify(detail));
  }

  /** Newest first. `action`: exact action or a prefix ending with "." (e.g. "invite."). */
  logList(q: { limit?: number; before?: number; action?: string } = {}): AdminLogEntry[] {
    const limit = Math.min(Math.max(1, q.limit ?? 100), 1000);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.before) (where.push("id < ?"), args.push(q.before));
    if (q.action) {
      if (q.action.endsWith(".")) (where.push("action LIKE ?"), args.push(`${q.action}%`));
      else (where.push("action = ?"), args.push(q.action));
    }
    const rows = this.db
      .prepare(`SELECT id, at, actor, action, target, detail FROM admin_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as { id: number; at: number; actor: string; action: string; target: string; detail: string }[];
    return rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor, action: r.action, target: r.target, detail: safeJson(r.detail) }));
  }

  // --- accounts

  accounts(): AccountSummary[] {
    const pool = this.poolUsage();
    const sizes = new Map<string, number>();
    const addSize = (sql: string) => {
      for (const r of this.db.prepare(sql).all() as { a: string; n: number }[]) sizes.set(r.a, (sizes.get(r.a) ?? 0) + Number(r.n));
    };
    if (has(this.db, "log")) addSize("SELECT account_id AS a, coalesce(sum(length(entry)), 0) AS n FROM log GROUP BY account_id");
    if (has(this.db, "vault")) addSize("SELECT account_id AS a, coalesce(sum(length(blob)), 0) AS n FROM vault GROUP BY account_id");
    if (has(this.db, "shares")) addSize("SELECT account_id AS a, coalesce(sum(length(meta) + length(atts) + length(owner_note)), 0) AS n FROM shares GROUP BY account_id");
    const rows = this.db
      .prepare(
        `SELECT a.id, a.created_at, a.last_seen_at, a.admin, a.blocked_at, a.blocked_reason,
           (SELECT count(*) FROM devices d WHERE d.account_id = a.id) AS devices,
           (SELECT note FROM invites i WHERE i.used_by = a.id) AS invite_note
         FROM accounts a ORDER BY a.created_at, a.id`,
      )
      .all() as { id: string; created_at: number; last_seen_at: number | null; admin: number; blocked_at: number | null; blocked_reason: string | null; devices: number; invite_note: string | null }[];
    return rows.map((r) => ({
      accountId: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      devices: Number(r.devices),
      serverBytes: sizes.get(r.id) ?? 0,
      poolBytes: pool ? (pool.get(r.id) ?? 0) : null,
      state: r.blocked_at !== null ? "blocked" : "active",
      blockedAt: r.blocked_at,
      blockedReason: r.blocked_reason,
      inviteNote: r.invite_note,
      admin: r.admin === 1,
    }));
  }

  /**
   * e2ee/plain (the instance stores pieces): bytes per account on Discord, live pieces + snapshot
   * objects (the same sum as Settings → Storage of the account). Null in metadata only.
   */
  poolUsage(): Map<string, number> | null {
    if (!has(this.db, "s_blobs")) return null;
    const m = new Map<string, number>();
    const up = has(this.db, "s_uploads");
    const rows = this.db
      .prepare(
        up
          ? "SELECT b.account_id AS a, coalesce(sum(b.size), 0) AS n FROM s_blobs b LEFT JOIN s_uploads u USING (account_id, upload_id) WHERE b.deleted_at IS NULL AND coalesce(u.state, 'open') NOT IN ('aborted', 'reaped', 'purged') GROUP BY b.account_id"
          : "SELECT account_id AS a, coalesce(sum(size), 0) AS n FROM s_blobs WHERE deleted_at IS NULL GROUP BY account_id",
      )
      .all() as { a: string; n: number }[];
    for (const r of rows) m.set(r.a, Number(r.n));
    if (has(this.db, "s_snap_objs")) for (const r of this.db.prepare("SELECT account_id AS a, coalesce(sum(size), 0) AS n FROM s_snap_objs GROUP BY account_id").all() as { a: string; n: number }[]) m.set(r.a, (m.get(r.a) ?? 0) + Number(r.n));
    return m;
  }

  account(accountId: string): AccountSummary | null {
    return this.accounts().find((a) => a.accountId === accountId) ?? null;
  }

  exists(accountId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId);
  }

  isAdmin(accountId: string): boolean {
    const r = this.db.prepare("SELECT admin, blocked_at FROM accounts WHERE id = ?").get(accountId) as { admin: number; blocked_at: number | null } | undefined;
    return !!r && r.admin === 1 && r.blocked_at === null;
  }

  /** Accounts that can use the admin panel (flag set, not blocked). */
  adminCount(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM accounts WHERE admin = 1 AND blocked_at IS NULL").get() as { n: number }).n);
  }

  /** Full account ID from the ID itself or a unique prefix (with or without "acct-"). */
  resolve(ref: string): string {
    const q = String(ref ?? "").trim();
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(q)) throw new AdminError(400, "bad_account_ref");
    const full = q.startsWith("acct-") ? q : `acct-${q}`;
    const rows = this.db.prepare("SELECT id FROM accounts WHERE id = ? OR substr(id, 1, ?) = ? LIMIT 2").all(full, full.length, full) as { id: string }[];
    const exact = rows.find((r) => r.id === full);
    if (exact) return exact.id;
    if (rows.length === 0) throw new AdminError(404, "no_such_account");
    if (rows.length > 1) throw new AdminError(409, "ambiguous_account");
    return rows[0]!.id;
  }

  devices(accountId: string): AdminDevice[] {
    return (this.db.prepare("SELECT id, created_at, last_seen_at, added_by FROM devices WHERE account_id = ? ORDER BY created_at, id").all(accountId) as {
      id: string;
      created_at: number;
      last_seen_at: number | null;
      added_by: string;
    }[]).map((d) => ({ deviceId: d.id, createdAt: d.created_at, lastSeenAt: d.last_seen_at, addedBy: d.added_by }));
  }

  private need(accountId: string): void {
    if (!this.exists(accountId)) throw new AdminError(404, "no_such_account");
  }

  /** Block: no sign-in, sync, pairing or notifications; sessions end now. Data stays. */
  block(accountId: string, reason: string, actor: string): void {
    this.need(accountId);
    const why = String(reason ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    this.db.prepare("UPDATE accounts SET blocked_at = coalesce(blocked_at, ?), blocked_reason = ? WHERE id = ?").run(this.now(), why || null, accountId);
    this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
    this.log(actor, "account.block", accountId, why ? { reason: why } : {});
  }

  unblock(accountId: string, actor: string): void {
    this.need(accountId);
    this.db.prepare("UPDATE accounts SET blocked_at = NULL, blocked_reason = NULL WHERE id = ?").run(accountId);
    this.log(actor, "account.unblock", accountId);
  }

  /**
   * Grant or take the admin flag. From the web app (`panel`) the last admin cannot lose it
   * (only the operator CLI can do that: shell access is the root of trust).
   */
  setAdmin(accountId: string, on: boolean, actor: string, panel = false): void {
    this.need(accountId);
    if (!on && panel && this.isAdmin(accountId) && this.adminCount() <= 1) throw new AdminError(409, "last_admin");
    this.db.prepare("UPDATE accounts SET admin = ? WHERE id = ?").run(on ? 1 : 0, accountId);
    this.log(actor, on ? "account.admin_on" : "account.admin_off", accountId);
  }

  /** Revoke one device of an account (its sessions end with it). */
  revokeDevice(accountId: string, deviceId: string, actor: string): void {
    const r = this.db.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").run(deviceId, accountId);
    if (r.changes === 0) throw new AdminError(404, "no_such_device");
    this.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
    this.log(actor, "device.revoke", accountId, { deviceId });
  }

  /**
   * Delete an account's data on this server, now. When the instance keeps pieces on Discord
   * (e2ee/plain: the s_blobs table exists), a background deletion is queued for the running
   * server; metadata only: done here (nothing on Discord is touched).
   */
  deleteAccount(accountId: string, actor: string): DeletionStatus {
    this.need(accountId);
    const t = this.now();
    const pieces = has(this.db, "s_blobs");
    let total = 0;
    if (pieces) {
      total += Number((this.db.prepare("SELECT count(*) AS n FROM s_blobs WHERE account_id = ? AND deleted_at IS NULL").get(accountId) as { n: number }).n);
      if (has(this.db, "s_snap_objs")) total += Number((this.db.prepare("SELECT count(*) AS n FROM s_snap_objs WHERE account_id = ?").get(accountId) as { n: number }).n);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, col] of ACCOUNT_TABLES) if (has(this.db, table)) this.db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(accountId);
      this.db
        .prepare(
          `INSERT INTO account_deletions (account_id, requested_at, by, state, total, done, error, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET requested_at = excluded.requested_at, by = excluded.by, state = excluded.state, total = excluded.total, done = 0,
             error = NULL, updated_at = excluded.updated_at, finished_at = excluded.finished_at`,
        )
        .run(accountId, t, actor, pieces ? "pending" : "done", total, t, pieces ? null : t);
      this.log(actor, "account.delete", accountId, pieces ? { pieces: total } : {});
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.deletion(accountId)!;
  }

  deletion(accountId: string): DeletionStatus | null {
    return this.deletions().find((d) => d.accountId === accountId) ?? null;
  }

  /** Account deletions, unfinished first, then the last finished ones. */
  deletions(limit = 50): DeletionStatus[] {
    return (this.db
      .prepare("SELECT * FROM account_deletions ORDER BY CASE WHEN state IN ('pending', 'running') THEN 0 ELSE 1 END, updated_at DESC LIMIT ?")
      .all(limit) as { account_id: string; requested_at: number; by: string; state: DeletionStatus["state"]; total: number; done: number; error: string | null; updated_at: number; finished_at: number | null }[]).map((r) => ({
      accountId: r.account_id,
      requestedAt: r.requested_at,
      by: r.by,
      state: r.state,
      total: Number(r.total),
      done: Number(r.done),
      error: r.error,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
    }));
  }

  // --- sign-up policy (live: the running server reads it on every sign-up)

  signup(fallback: SignupPolicy): SignupPolicy {
    const r = this.db.prepare("SELECT v FROM server_meta WHERE k = 'signup'").get() as { v: string } | undefined;
    return r && (SIGNUP_POLICIES as string[]).includes(r.v) ? (r.v as SignupPolicy) : fallback;
  }

  setSignup(policy: SignupPolicy, actor: string | null): void {
    if (!(SIGNUP_POLICIES as string[]).includes(policy)) throw new AdminError(400, "bad_signup");
    const old = (this.db.prepare("SELECT v FROM server_meta WHERE k = 'signup'").get() as { v: string } | undefined)?.v ?? null;
    this.db.prepare("INSERT INTO server_meta (k, v) VALUES ('signup', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(policy);
    if (actor && old !== policy) this.log(actor, "signup.set", "", { from: old, to: policy });
  }

  // --- first account becomes admin (chosen in setup)

  setFirstAccountAdmin(on: boolean): void {
    if (on) this.db.prepare("INSERT INTO server_meta (k, v) VALUES ('first_account_admin', '1') ON CONFLICT(k) DO UPDATE SET v = '1'").run();
    else this.db.prepare("DELETE FROM server_meta WHERE k = 'first_account_admin'").run();
  }

  firstAccountAdminPending(): boolean {
    return !!this.db.prepare("SELECT 1 FROM server_meta WHERE k = 'first_account_admin'").get();
  }

  /** Called right after an account was created: the first one takes the admin flag if setup asked for it. */
  claimFirstAdmin(accountId: string): boolean {
    const r = this.db.prepare("DELETE FROM server_meta WHERE k = 'first_account_admin' RETURNING v").get() as { v: string } | undefined;
    if (!r) return false;
    // Only the very first account (setup re-run on an instance with accounts never arms it, see setup).
    if (Number((this.db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n) !== 1) return false;
    this.db.prepare("UPDATE accounts SET admin = 1 WHERE id = ?").run(accountId);
    this.log(OPERATOR, "account.admin_on", accountId, { first: true });
    return true;
  }

  accountCount(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n);
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
