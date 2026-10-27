// discordrive-next metadata-only server: arbiter of the
// encrypted operation log, webhook vault storage, upload leases.
// Sees only the plaintext fields its contract allows: account/devices, opId, rulesVersion, baseSeq,
// leaseGuard, sizes of encrypted blobs, server times.
//
// Reference implementation for stage 2: node:http + node:sqlite, binds to
// 127.0.0.1 by default (no public domain). Notifications: long-poll on
// GET /v1/log?wait=<s> (a websocket can replace it without touching clients'
// EncryptedLogApi).
//
// Auth is behind `Authenticator` (auth.ts): Ed25519 key per device, sign-in by
// signing a one-shot challenge, short session tokens (decision #13).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { MIN_REPLAY_RULES_VERSION, RULES_VERSION, Sequencer, isClientId } from "@ddv4/sync-core";
import type { EncryptedEntry, EncryptedEnvelope } from "../op-crypto.js";
import { PAIRING_TTL_MS } from "../pairing.js";
import { AuthError, Ed25519Authenticator, type Authenticator, type Session } from "./auth.js";
import { PasswordKeyStore, RateLimitedAuth } from "./password-keys.js";
import { InviteError, InviteStore } from "./invites.js";
import { AdminError, AdminStore, OPERATOR, type SignupPolicy } from "./admin.js";
import { IpLimiter, clientIp, type BucketSpec } from "./ip-limit.js";
import { NotifyHub } from "./notify.js";
import { ShareStore, type BotRefresher } from "./shares.js";
import { StaticSite, type StaticOptions } from "./static.js";

export type { Authenticator, Session };

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_PAYLOAD_B64 = 1024 * 1024;
export const MAX_VAULT_B64 = 512 * 1024;
/** Account settings (small JSON): 64 KiB of base64. */
export const MAX_SETTINGS_B64 = 64 * 1024;
/**
 * Named slots of an account (the Safe: GET/PUT /v1/slots/safe), sealed by the client, opaque here: the padded
 * state (≤ 1 MiB) and its header, in base64.
 */
export const SLOT_NAMES = ["safe"] as const;
export const MAX_SLOT_B64 = Math.ceil((1024 * 1024 + 4096) / 3) * 4;
/**
 * Earlier revisions of a slot the instance keeps (an overwritten or damaged Safe can be brought back by the
 * client, which re-seals the old one under a new revision): the last SLOT_KEEP, and every one younger than
 * SLOT_KEEP_MS up to SLOT_KEEP_MAX. Against mistakes and a broken client, not against a user of the account
 * who wants it gone (they can delete it; the threat model says so).
 */
export const SLOT_KEEP = 20;
export const SLOT_KEEP_MS = 30 * 24 * 3600_000;
export const SLOT_KEEP_MAX = 200;
export const MAX_DEVICE_NAME_B64 = 1024;
export const SERVER_VERSION = "0.2.0";

export interface ServerLimits {
  /** Any JSON request body (bytes). */
  bodyBytes: number;
  /** Encrypted operation payload (base64 chars). */
  opPayloadB64: number;
  /** Encrypted webhook vault (base64 chars). */
  vaultB64: number;
}
export const DEFAULT_LIMITS: ServerLimits = { bodyBytes: MAX_BODY_BYTES, opPayloadB64: MAX_PAYLOAD_B64, vaultB64: MAX_VAULT_B64 };

/** Per-IP buckets for unauthenticated endpoints. */
export const DEFAULT_RATE_LIMITS: Record<"auth" | "signup" | "mailbox" | "share" | "password", BucketSpec> = {
  auth: { burst: 60, perMin: 60 },
  signup: { burst: 5, perMin: 2 },
  mailbox: { burst: 60, perMin: 90 },
  share: { burst: 60, perMin: 120 },
  /** Password sign-in (params + key), per IP; the per-account limit is in PasswordKeyStore. */
  password: { burst: 10, perMin: 5 },
};
const MAX_WAIT_S = 30;

/**
 * A mode plugs its server side in here (stage 3): e2ee/plain add
 * instance webhooks, blob upload/download and background work. Metadata only adds nothing.
 */
export interface ServerExtension {
  readonly name: string;
  /** Called once from the DdnServer constructor (tables, timers). */
  init?(srv: DdnServer): void;
  /** Handle a request; return true when it was answered. Runs before the built-in /v1 routes. */
  route?(r: ExtRequest): Promise<boolean>;
  /** Extra fields for GET /v1/health. */
  health?(): Record<string, unknown>;
  /** Extra fields for the admin panel's instance screen (e2ee/plain: the pool with usage). */
  adminInfo?(): Record<string, unknown>;
  /** An account was deleted and its pieces are gone: drop what the extension keeps for it (files, caches). */
  accountGone?(accountId: string): void;
  /** Called after an entry is appended to an account's log. */
  onAppend?(accountId: string, entry: EncryptedEntry): void;
  /** May a device take/renew the lease of this upload? (e2ee: not after the server reaped it.) */
  leaseGate?(accountId: string, uploadId: string, deviceId: string): boolean;
  close?(): Promise<void>;
}

export interface ExtRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  url: URL;
  /** Signed-in session or a 401 HttpError. */
  session(): Session;
  json(): Promise<unknown>;
  send(status: number, body: unknown, headers?: Record<string, string>): void;
  limit(kind: keyof typeof DEFAULT_RATE_LIMITS): void;
}

export interface ServerOptions {
  dbPath?: string;
  /** Mode-specific server parts (stage 3). */
  extensions?: ServerExtension[];
  now?: () => number;
  leaseMs?: number;
  minRulesVersion?: number;
  maxRulesVersion?: number;
  /**
   * Account creation: "open" (anyone), "invite" (one-shot code from
   * `discordrive invite`), "closed". Default "open" (tests); `discordrive
   * setup` writes "invite" for public instances. `openSignup: false` = "closed".
   */
  signup?: "open" | "invite" | "closed";
  openSignup?: boolean;
  /** Peers whose X-Forwarded-For is trusted for the client IP (reverse proxy). */
  trustProxy?: string[];
  limits?: Partial<ServerLimits>;
  /** Per-IP limits; `false` turns them off (tests). */
  rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS> | false;
  /** Serve the built web app from the same origin. */
  web?: StaticOptions;
  /** Instance bot for share links. Without it shares answer 503. */
  bot?: BotRefresher;
  /** Allowed CDN origin of shared attachments (tests: the fake Discord). */
  cdnOrigins?: string[];
  mode?: string;
  /** Default language of the web app for this instance (users can switch). */
  language?: string;
  /** Build of the code this instance runs (version + source hash + commit; `/v1/health`, Settings, logs). */
  build?: string;
  /** Browser origins allowed via CORS (exact match). Default: none. */
  corsOrigins?: string[];
  /** Session token lifetime (default 1 h). */
  sessionTtlMs?: number;
  /** The sign-up policy was changed from the admin panel (the instance saves it in its config). */
  onSignupChange?: (policy: SignupPolicy) => void;
  /** Health checks for the admin panel (the instance runs the same checks as `discordrive doctor`). */
  doctor?: () => Promise<{ level: "ok" | "warn" | "fail"; what: string; detail: string }[]>;
  /** How often the server notices administrative changes made by the CLI in the same database (ms; 0 = off). */
  adminSweepMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}


export class DdnServer {
  readonly db: DatabaseSync;
  private readonly seqs = new Map<string, Sequencer<EncryptedEnvelope>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  readonly auth: Ed25519Authenticator;
  private http: Server | null = null;
  readonly notify: NotifyHub;
  readonly invites: InviteStore;
  readonly shares: ShareStore;
  readonly passwords: PasswordKeyStore;
  readonly admin: AdminStore;
  private readonly limits: ServerLimits;
  private readonly signupDefault: SignupPolicy;
  private readonly ipLimits: Partial<Record<keyof typeof DEFAULT_RATE_LIMITS, IpLimiter>> = {};
  private readonly web: StaticSite | null;
  private readonly startedAt: number;

  constructor(private readonly opts: ServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.db = new DatabaseSync(opts.dbPath ?? ":memory:");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS log (
        account_id TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT NOT NULL, entry TEXT NOT NULL,
        PRIMARY KEY (account_id, seq), UNIQUE (account_id, op_id));
      CREATE TABLE IF NOT EXISTS vault (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, blob TEXT NOT NULL);
      -- Account settings shared by its devices (every mode), sealed with the account key: opaque here.
      CREATE TABLE IF NOT EXISTS settings (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, blob TEXT NOT NULL);
      -- Named slots of an account (the Safe), sealed by the client with keys the instance never has: opaque.
      CREATE TABLE IF NOT EXISTS slots (account_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (account_id, name));
      CREATE TABLE IF NOT EXISTS slot_history (account_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, blob TEXT NOT NULL, replaced_at INTEGER NOT NULL, PRIMARY KEY (account_id, name, revision));
      CREATE TABLE IF NOT EXISTS pairing (id TEXT PRIMARY KEY, msg TEXT NOT NULL, created_at INTEGER NOT NULL);
      -- Cleanup bookkeeping (metadata only: the client deletes fragments, the server remembers
      -- which uploads are done and when the account was last cleaned; upload IDs are plaintext already).
      CREATE TABLE IF NOT EXISTS gc_runs (account_id TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_done (account_id TEXT NOT NULL, upload_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (account_id, upload_id));
    `);
    this.auth = new Ed25519Authenticator(this.db, this.now, opts.sessionTtlMs);
    this.notify = new NotifyHub(this.now);
    this.invites = new InviteStore(this.db, this.now);
    this.shares = new ShareStore(this.db, this.now, opts.bot ?? null, opts.cdnOrigins);
    this.passwords = new PasswordKeyStore(this.db, this.now);
    this.admin = new AdminStore(this.db, this.now);
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.signupDefault = opts.signup ?? (opts.openSignup === false ? "closed" : "open");
    if (opts.rateLimits !== false) {
      const spec = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
      for (const k of Object.keys(spec) as (keyof typeof spec)[]) this.ipLimits[k] = new IpLimiter(spec[k], this.now);
    }
    this.web = opts.web ? new StaticSite(opts.web) : null;
    this.startedAt = this.now();
    this.lockMode(opts.mode ?? "metadata-only");
    this.extensions = opts.extensions ?? [];
    for (const x of this.extensions) x.init?.(this);
    if ((opts.adminSweepMs ?? 2000) > 0) {
      this.sweepTimer = setInterval(() => this.adminSweep(), opts.adminSweepMs ?? 2000);
      this.sweepTimer.unref?.();
    }
  }

  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private dataVersion = -1;

  /** The live sign-up policy: changed by `discordrive signup` or the admin panel without a restart. */
  get signup(): SignupPolicy {
    return this.admin.signup(this.signupDefault);
  }

  /**
   * End what a blocked or deleted account (or a revoked device) still has open in this process:
   * notification sockets, long-polls, the cached log. Called after changes made here and, through
   * PRAGMA data_version, after changes the operator CLI committed to the same database.
   */
  adminSweep(force = false): void {
    let v: number;
    try {
      v = Number((this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
    } catch {
      return; // closed
    }
    if (!force && v === this.dataVersion) return;
    this.dataVersion = v;
    const live = new Set((this.db.prepare("SELECT id FROM accounts WHERE blocked_at IS NULL").all() as { id: string }[]).map((r) => r.id));
    for (const acct of this.notify.openAccounts()) {
      if (!live.has(acct)) this.endAccount(acct);
      else for (const dev of this.notify.openDevices(acct)) if (!this.db.prepare("SELECT 1 FROM devices WHERE id = ?").get(dev)) this.notify.closeAccount(acct, dev);
    }
    for (const acct of [...this.waiters.keys()]) if (!live.has(acct)) for (const w of [...(this.waiters.get(acct) ?? [])]) w();
    for (const acct of [...this.seqs.keys()]) if (!this.admin.exists(acct)) this.seqs.delete(acct);
  }

  private endAccount(accountId: string): void {
    this.notify.closeAccount(accountId);
    for (const w of [...(this.waiters.get(accountId) ?? [])]) w();
  }

  readonly extensions: ServerExtension[];

  /**
   * One instance = one mode, forever: the first start writes the mode into the
   * database; a later start with another mode refuses to run instead of misreading the data.
   */
  private lockMode(mode: string): void {
    const row = this.db.prepare("SELECT v FROM server_meta WHERE k = 'mode'").get() as { v: string } | undefined;
    if (!row) this.db.prepare("INSERT INTO server_meta (k, v) VALUES ('mode', ?)").run(mode);
    else if (row.v !== mode) {
      this.db.close();
      throw new ModeMismatchError(row.v, mode);
    }
  }

  /** Server clock (extensions use it so tests can drive time). */
  get clock(): () => number {
    return this.now;
  }

  /** Does `deviceId` hold an unexpired lease on the upload (rule 8)? */
  holdsLease(accountId: string, uploadId: string, deviceId: string): boolean {
    return this.seq(accountId).holdsLease(uploadId, deviceId);
  }

  /** Lease of an upload, expired or not (background cleanup). */
  leaseOf(accountId: string, uploadId: string): { deviceId: string; expiresAt: number } | undefined {
    return this.seq(accountId).leaseOf(uploadId);
  }

  /** Encrypted log of an account (background snapshots). */
  logRead(accountId: string, after: number, limit: number): EncryptedEntry[] {
    return this.seq(accountId).read(after, limit);
  }

  logHead(accountId: string): number {
    return this.seq(accountId).headSeq;
  }

  /** Accounts with at least one log entry. */
  accountsWithLog(): string[] {
    return (this.db.prepare("SELECT DISTINCT account_id FROM log").all() as { account_id: string }[]).map((r) => r.account_id);
  }

  health() {
    const extra = Object.assign({}, ...this.extensions.map((x) => x.health?.() ?? {}));
    return {
      ...extra,
      ok: true,
      service: "discordrive-next",
      version: SERVER_VERSION,
      ...(this.opts.build ? { build: this.opts.build } : {}),
      mode: this.opts.mode ?? "metadata-only",
      rulesVersion: RULES_VERSION,
      uptimeS: Math.round((this.now() - this.startedAt) / 1000),
      signup: this.signup,
      shares: this.shares.available,
      language: this.opts.language ?? "en",
    };
  }

  private limit(kind: keyof typeof DEFAULT_RATE_LIMITS, req: IncomingMessage): void {
    const l = this.ipLimits[kind];
    if (!l) return;
    const wait = l.take(`${kind}|${clientIp(req, this.opts.trustProxy ?? [])}`);
    if (wait > 0) throw new HttpError(429, "rate_limited", { "retry-after": String(wait) });
  }

  private seq(accountId: string): Sequencer<EncryptedEnvelope> {
    let s = this.seqs.get(accountId);
    if (!s) {
      const rows = this.db.prepare("SELECT entry FROM log WHERE account_id = ? ORDER BY seq").all(accountId) as { entry: string }[];
      s = new Sequencer<EncryptedEnvelope>({
        now: this.now,
        leaseMs: this.opts.leaseMs,
        // Accept every rules version this build replays (2..3): a tab still running the previous bundle
        // writes valid rules-2 entries until it reloads; it cannot read a rules-3 entry, so it never
        // writes after one (rule 10: it pulls before it sends).
        minRulesVersion: this.opts.minRulesVersion ?? MIN_REPLAY_RULES_VERSION,
        maxRulesVersion: this.opts.maxRulesVersion ?? RULES_VERSION,
        initialLog: rows.map((r) => JSON.parse(r.entry) as EncryptedEntry),
      });
      this.seqs.set(accountId, s);
    }
    return s;
  }

  // --- API (also callable in-process)

  submit(s: Session, body: unknown) {
    const env = validateEnvelope(body, this.limits.opPayloadB64);
    const sq = this.seq(s.accountId);
    const r = sq.submit(env, s.deviceId);
    if (r.status === "accepted") {
      this.db.prepare("INSERT INTO log (account_id, seq, op_id, entry) VALUES (?, ?, ?, ?)").run(s.accountId, r.entry.seq, r.entry.opId, JSON.stringify(r.entry));
      for (const w of this.waiters.get(s.accountId) ?? []) w();
      this.notify.publish(s.accountId, r.entry.seq);
      for (const x of this.extensions) x.onAppend?.(s.accountId, r.entry);
    }
    return r;
  }

  async read(s: Session, after: number, limit: number, waitS: number): Promise<EncryptedEntry[]> {
    const sq = this.seq(s.accountId);
    const got = sq.read(after, limit);
    if (got.length > 0 || waitS <= 0) return got;
    await new Promise<void>((resolve) => {
      let set = this.waiters.get(s.accountId);
      if (!set) this.waiters.set(s.accountId, (set = new Set()));
      const done = () => {
        clearTimeout(t);
        set!.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.min(waitS, MAX_WAIT_S) * 1000);
      set.add(done);
    });
    return sq.read(after, limit);
  }

  renewLease(s: Session, uploadId: string): boolean {
    if (!this.extensions.every((x) => x.leaseGate?.(s.accountId, uploadId, s.deviceId) ?? true)) return false;
    return this.seq(s.accountId).renewLease(uploadId, s.deviceId);
  }
  releaseLease(s: Session, uploadId: string): void {
    this.seq(s.accountId).releaseLease(uploadId, s.deviceId);
  }

  getSlot(s: Session, name: string): { revision: number; blob: string } | null {
    return (this.db.prepare("SELECT revision, blob FROM slots WHERE account_id = ? AND name = ?").get(s.accountId, name) as { revision: number; blob: string } | undefined) ?? null;
  }

  /**
   * Compare-and-swap of a named slot (the Safe), like the vault; never deleted by a client (an empty Safe stays).
   * `dropHistory: true` (a new password) forgets the earlier revisions in the same transaction: they hold the
   * master under the old password, which must stop opening the Safe.
   */
  putSlot(s: Session, name: string, body: unknown): { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } {
    const b = body as { expectedRevision?: unknown; revision?: unknown; blob?: unknown; dropHistory?: unknown };
    if (!Number.isInteger(b?.expectedRevision) || !Number.isInteger(b?.revision) || typeof b?.blob !== "string") throw new HttpError(400, "bad_slot");
    if (b.dropHistory !== undefined && typeof b.dropHistory !== "boolean") throw new HttpError(400, "bad_slot");
    if ((b.blob as string).length > MAX_SLOT_B64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.blob as string)) throw new HttpError(400, "bad_slot_blob");
    const exp = b.expectedRevision as number;
    const rev = b.revision as number;
    let out: { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } = { status: "ok" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.getSlot(s, name);
      if ((cur?.revision ?? 0) !== exp || rev !== exp + 1) out = { status: "conflict", current: cur };
      else {
        if (b.dropHistory === true) this.db.prepare("DELETE FROM slot_history WHERE account_id = ? AND name = ?").run(s.accountId, name);
        // The replaced revision goes to the history (kept for a while, see SLOT_KEEP); not after a new password.
        else if (cur) {
          this.db.prepare("INSERT OR REPLACE INTO slot_history (account_id, name, revision, blob, replaced_at) VALUES (?, ?, ?, ?, ?)").run(s.accountId, name, cur.revision, cur.blob, this.now());
          this.db
            .prepare(
              `DELETE FROM slot_history WHERE account_id = ? AND name = ? AND revision NOT IN (
                 SELECT revision FROM slot_history WHERE account_id = ? AND name = ? ORDER BY revision DESC LIMIT ?)
               AND (replaced_at < ? OR revision NOT IN (SELECT revision FROM slot_history WHERE account_id = ? AND name = ? ORDER BY revision DESC LIMIT ?))`,
            )
            .run(s.accountId, name, s.accountId, name, SLOT_KEEP, this.now() - SLOT_KEEP_MS, s.accountId, name, SLOT_KEEP_MAX);
        }
        this.db
          .prepare("INSERT INTO slots (account_id, name, revision, blob) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, name) DO UPDATE SET revision = excluded.revision, blob = excluded.blob")
          .run(s.accountId, name, rev, b.blob as string);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  getVault(s: Session, table: "vault" | "settings" = "vault"): { revision: number; blob: string } | null {
    return (this.db.prepare(`SELECT revision, blob FROM ${table} WHERE account_id = ?`).get(s.accountId) as { revision: number; blob: string } | undefined) ?? null;
  }

  /** Compare-and-swap of a sealed blob of the account: the webhook vault (metadata only) or the settings. */
  putVault(s: Session, body: unknown, table: "vault" | "settings" = "vault"): { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } {
    const b = body as { expectedRevision?: unknown; revision?: unknown; blob?: unknown };
    if (!Number.isInteger(b?.expectedRevision) || !Number.isInteger(b?.revision) || typeof b?.blob !== "string") throw new HttpError(400, "bad_vault");
    if ((b.blob as string).length > (table === "settings" ? MAX_SETTINGS_B64 : this.limits.vaultB64) || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.blob as string)) throw new HttpError(400, "bad_vault_blob");
    const exp = b.expectedRevision as number;
    const rev = b.revision as number;
    let out: { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } = { status: "ok" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.getVault(s, table);
      if ((cur?.revision ?? 0) !== exp || rev !== exp + 1) out = { status: "conflict", current: cur };
      else
        this.db
          .prepare(`INSERT INTO ${table} (account_id, revision, blob) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision, blob = excluded.blob`)
          .run(s.accountId, rev, b.blob as string);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  // --- cleanup bookkeeping (metadata only)

  gcStatus(s: Session): { now: number; lastRunAt: number | null; firstEntryAt: number | null; doneCount: number } {
    const run = this.db.prepare("SELECT last_run_at FROM gc_runs WHERE account_id = ?").get(s.accountId) as { last_run_at: number } | undefined;
    const first = this.seq(s.accountId).read(0, 1)[0];
    const done = this.db.prepare("SELECT count(*) AS n FROM gc_done WHERE account_id = ?").get(s.accountId) as { n: number };
    return { now: this.now(), lastRunAt: run?.last_run_at ?? null, firstEntryAt: first?.serverTime ?? null, doneCount: Number(done.n) };
  }

  gcDone(s: Session, body: unknown): string[] {
    const ids = (body as { uploads?: unknown })?.uploads;
    if (!Array.isArray(ids) || ids.length > 5000 || !ids.every(isClientId)) throw new HttpError(400, "bad_uploads");
    const q = this.db.prepare("SELECT 1 FROM gc_done WHERE account_id = ? AND upload_id = ?");
    return (ids as string[]).filter((u) => q.get(s.accountId, u));
  }

  gcRecord(s: Session, body: unknown): void {
    const b = body as { uploads?: unknown; run?: unknown };
    if (!Array.isArray(b?.uploads) || b.uploads.length > 5000 || !b.uploads.every(isClientId)) throw new HttpError(400, "bad_uploads");
    const ins = this.db.prepare("INSERT OR IGNORE INTO gc_done (account_id, upload_id, at) VALUES (?, ?, ?)");
    for (const u of b.uploads as string[]) ins.run(s.accountId, u, this.now());
    if (b.run === true) this.db.prepare("INSERT INTO gc_runs (account_id, last_run_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET last_run_at = excluded.last_run_at").run(s.accountId, this.now());
  }

  // --- pairing mailbox: one opaque message per pairingId, deleted on read, 10 min TTL.
  // Writing needs a session (an existing device); reading does not (the new
  // device has no credential yet; the pairingId is a 128-bit secret from the QR).

  pairingPut(_s: Session, id: string, body: unknown): void {
    const b = body as { pub?: unknown; sealed?: unknown };
    if (typeof b?.pub !== "string" || typeof b?.sealed !== "string" || b.pub.length > 200 || b.sealed.length > 16_384) throw new HttpError(400, "bad_pairing");
    this.db.prepare("DELETE FROM pairing WHERE created_at < ?").run(this.now() - PAIRING_TTL_MS);
    try {
      this.db.prepare("INSERT INTO pairing (id, msg, created_at) VALUES (?, ?, ?)").run(id, JSON.stringify({ pub: b.pub, sealed: b.sealed }), this.now());
    } catch {
      throw new HttpError(409, "pairing_slot_used");
    }
  }

  pairingTake(id: string): { pub: string; sealed: string } | null {
    const r = this.db.prepare("DELETE FROM pairing WHERE id = ? RETURNING msg, created_at").get(id) as { msg: string; created_at: number } | undefined;
    if (!r || this.now() - r.created_at > PAIRING_TTL_MS) return null;
    return JSON.parse(r.msg) as { pub: string; sealed: string };
  }

  // --- HTTP

  async listen(port = 0, host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        const he =
          e instanceof HttpError
            ? e
            : e instanceof RateLimitedAuth
              ? new HttpError(429, "rate_limited", { "retry-after": String(e.retryAfterS) })
              : e instanceof AuthError || e instanceof AdminError
                ? new HttpError(e.status, e.code)
                : e instanceof InviteError
                  ? new HttpError(e.code === "no_such_invite" ? 404 : e.code === "bad_invite_ref" ? 400 : 409, e.code)
                  : new HttpError(500, "internal");
        if (!(e instanceof HttpError) && !(e instanceof AuthError) && !(e instanceof AdminError) && !(e instanceof InviteError)) console.error("ddn-server:", (e as Error)?.message);
        send(res, he.status, { error: he.code }, he.headers);
      });
    });
    this.http.on("upgrade", (req, socket) => {
      // Non-browser clients send no Origin; browsers must be on the allow-list.
      // Non-browser clients send no Origin; browsers must be same-origin or on the allow-list.
      const allowed = (origin: string | undefined) => origin === undefined || !!this.opts.corsOrigins?.includes(origin) || sameOrigin(origin, req.headers.host);
      if (!this.notify.handleUpgrade(req, socket, allowed)) socket.destroy();
    });
    // Reject (EADDRINUSE, EADDRNOTAVAIL, EACCES) instead of an unhandled 'error' event.
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        this.http = null;
        reject(e);
      };
      this.http!.once("error", onError);
      this.http!.listen(port, host, () => {
        this.http!.off("error", onError);
        resolve();
      });
    });
    const addr = this.http.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    return { url: `http://${host}:${p}`, port: p };
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const x of this.extensions) await x.close?.();
    for (const set of this.waiters.values()) for (const w of [...set]) w();
    this.notify.closeAll();
    if (this.http) await new Promise<void>((r) => this.http!.close(() => r()));
    this.http = null;
    this.db.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin && this.opts.corsOrigins?.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(origin && this.opts.corsOrigins?.includes(origin) ? 204 : 403);
      return void res.end();
    }
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";

    const json = () => readJson(req, this.limits.bodyBytes);
    if (this.extensions.length) {
      const r: ExtRequest = {
        req,
        res,
        method,
        path,
        url,
        json,
        session: () => {
          const s = this.auth.verify(req.headers.authorization);
          if (!s) throw new HttpError(401, "unauthorized");
          return s;
        },
        send: (status, body, headers) => send(res, status, body, headers),
        limit: (kind) => this.limit(kind, req),
      };
      for (const x of this.extensions) if (x.route && (await x.route(r))) return;
    }
    if (!path.startsWith("/v1/")) {
      if (this.web?.handle(req, res, path)) return;
      throw new HttpError(404, "not_found");
    }

    if (method === "GET" && path === "/v1/health") return send(res, 200, this.health());
    if (method === "POST" && path === "/v1/auth/challenge") return (this.limit("auth", req), send(res, 200, this.auth.challenge()));
    if (method === "POST" && path === "/v1/auth/login") return (this.limit("auth", req), send(res, 200, await this.auth.login(await json())));
    if (method === "POST" && path === "/v1/auth/password/params") return (this.limit("password", req), send(res, 200, this.passwords.params(await json())));
    if (method === "POST" && path === "/v1/auth/password/key") return (this.limit("password", req), send(res, 200, this.passwords.key(await json())));
    if (method === "POST" && path === "/v1/auth/rescue-device") return (this.limit("signup", req), send(res, 201, await this.auth.rescueAddDevice(await json())));
    if (method === "POST" && path === "/v1/accounts") {
      this.limit("signup", req);
      if (this.signup === "closed") throw new HttpError(403, "signup_closed");
      const body = await json();
      if (this.signup === "open") {
        const r = await this.auth.createAccount(body);
        this.admin.claimFirstAdmin(r.accountId);
        return send(res, 201, r);
      }
      const code = this.invites.claim((body as { invite?: unknown } | null)?.invite);
      if (!code) throw new HttpError(403, "invite_required");
      try {
        const r = await this.auth.createAccount(body);
        this.invites.markUsedBy(code, r.accountId);
        this.admin.claimFirstAdmin(r.accountId);
        return send(res, 201, r);
      } catch (e) {
        this.invites.release(code);
        throw e;
      }
    }
    const pair = /^\/v1\/pairing\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (pair && method === "GET") {
      this.limit("mailbox", req);
      const m = this.pairingTake(pair[1]!);
      return m ? send(res, 200, m) : send(res, 404, { error: "no_pairing_message" });
    }
    const share = /^\/v1\/shares\/([A-Za-z0-9_-]{22})(\/urls)?$/.exec(path);
    if (share && method === "GET") {
      this.limit("share", req);
      if (!share[2]) return send(res, 200, this.shares.get(share[1]!));
      return send(res, 200, await this.shares.urls(share[1]!, intParam(url, "from", 0), Math.min(intParam(url, "n", 50), 50)));
    }

    const s = this.auth.verify(req.headers.authorization);
    if (!s) throw new HttpError(401, "unauthorized");

    if (method === "POST" && path === "/v1/notify-ticket") return send(res, 200, this.notify.issueTicket(s.accountId, s.deviceId));
    // What this account may do on the instance (the web app shows "Admin" only when admin is true).
    if (method === "GET" && path === "/v1/account") return send(res, 200, { accountId: s.accountId, deviceId: s.deviceId, admin: this.admin.isAdmin(s.accountId) });
    if (path.startsWith("/v1/admin/")) return this.adminRoute(s, method, path, url, json, res);
    if (method === "POST" && path === "/v1/log") return send(res, 200, this.submit(s, await json()));
    if (method === "GET" && path === "/v1/log") {
      const after = intParam(url, "after", 0);
      const limit = Math.min(intParam(url, "limit", 1000), 5000);
      const wait = Math.min(intParam(url, "wait", 0), MAX_WAIT_S);
      return send(res, 200, { entries: await this.read(s, after, limit, wait) });
    }
    const lease = /^\/v1\/leases\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (lease) {
      if (method === "POST") return send(res, 200, { ok: this.renewLease(s, lease[1]!) });
      if (method === "DELETE") return (this.releaseLease(s, lease[1]!), send(res, 200, { ok: true }));
    }
    if (path === "/v1/vault") {
      if (method === "GET") {
        // No vault yet (new account): 200 with an empty state, not a 404 that
        // browsers log as an error. Clients also accept the old 404.
        const v = this.getVault(s);
        return send(res, 200, v ?? { revision: 0, blob: null });
      }
      if (method === "PUT") {
        const r = this.putVault(s, await json());
        return send(res, r.status === "ok" ? 200 : 409, r);
      }
    }
    // Settings of the account shared by its devices (every mode; e.g. the AI endpoint): the same
    // compare-and-swap as the vault, a separate blob (the vault stays metadata only's).
    if (path === "/v1/settings") {
      if (method === "GET") return send(res, 200, this.getVault(s, "settings") ?? { revision: 0, blob: null });
      if (method === "PUT") {
        const r = this.putVault(s, await json(), "settings");
        return send(res, r.status === "ok" ? 200 : 409, r);
      }
    }
    // Earlier revisions of a slot: the list (revision, when it was replaced, size) and one of them.
    const hist = /^\/v1\/slots\/([a-z]{1,16})\/history(?:\/(\d{1,12}))?$/.exec(path);
    if (hist && method === "GET") {
      if (!(SLOT_NAMES as readonly string[]).includes(hist[1]!)) throw new HttpError(404, "no_such_slot");
      if (hist[2]) {
        const r = this.db.prepare("SELECT revision, blob FROM slot_history WHERE account_id = ? AND name = ? AND revision = ?").get(s.accountId, hist[1]!, Number(hist[2])) as { revision: number; blob: string } | undefined;
        if (!r) throw new HttpError(404, "no_such_revision");
        return send(res, 200, r);
      }
      const rows = this.db.prepare("SELECT revision, replaced_at AS replacedAt, length(blob) AS chars FROM slot_history WHERE account_id = ? AND name = ? ORDER BY revision DESC").all(s.accountId, hist[1]!);
      return send(res, 200, { revisions: rows });
    }
    const slot = /^\/v1\/slots\/([a-z]{1,16})$/.exec(path);
    if (slot) {
      if (!(SLOT_NAMES as readonly string[]).includes(slot[1]!)) throw new HttpError(404, "no_such_slot");
      if (method === "GET") return send(res, 200, this.getSlot(s, slot[1]!) ?? { revision: 0, blob: null });
      if (method === "PUT") {
        const r = this.putSlot(s, slot[1]!, await json());
        return send(res, r.status === "ok" ? 200 : 409, r);
      }
    }
    if (path === "/v1/password-key") {
      if (method === "GET") return send(res, 200, this.passwords.status(s));
      if (method === "PUT") return (this.passwords.put(s, await json()), send(res, 200, this.passwords.status(s)));
      if (method === "DELETE") return (this.passwords.remove(s), send(res, 200, this.passwords.status(s)));
    }
    if (path === "/v1/gc" && method === "GET") return send(res, 200, this.gcStatus(s));
    if (path === "/v1/gc/done" && method === "POST") return send(res, 200, { done: this.gcDone(s, await json()) });
    if (path === "/v1/gc" && method === "POST") return (this.gcRecord(s, await json()), send(res, 200, { ok: true }));
    if (method === "POST" && path === "/v1/devices") return send(res, 201, await this.auth.addDevice(s, await json()));
    if (method === "GET" && path === "/v1/devices") return send(res, 200, { devices: this.auth.listDevices(s) });
    if (pair && method === "PUT") return (this.pairingPut(s, pair[1]!, await json()), send(res, 201, { ok: true }));
    const dev = /^\/v1\/devices\/([A-Za-z0-9_-]{4,80})(\/name)?$/.exec(path);
    if (dev && dev[2] && method === "PUT") {
      const b = (await json()) as { nameSealed?: unknown };
      if (typeof b?.nameSealed !== "string" || b.nameSealed.length > MAX_DEVICE_NAME_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.nameSealed)) throw new HttpError(400, "bad_device_name");
      this.auth.setDeviceName(s, dev[1]!, b.nameSealed);
      return send(res, 200, { ok: true });
    }
    if (dev && !dev[2] && method === "POST" && url.searchParams.get("action") === "revoke") {
      await this.auth.revokeDevice(s, dev[1]!, await json());
      this.notify.closeAccount(s.accountId, dev[1]!);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/v1/shares") return send(res, 201, this.shares.create(s, await json()));
    if (method === "GET" && path === "/v1/shares") return send(res, 200, { shares: this.shares.list(s) });
    if (share && !share[2] && method === "DELETE") return (this.shares.revoke(s, share[1]!), send(res, 200, { ok: true }));
    throw new HttpError(404, "not_found");
  }

  // --- administration (/v1/admin/...): the admin flag is checked here, on every call

  private async adminRoute(s: Session, method: string, path: string, url: URL, json: () => Promise<unknown>, res: ServerResponse): Promise<void> {
    if (!this.admin.isAdmin(s.accountId)) throw new HttpError(403, "not_admin");
    const actor = s.accountId;
    const a = this.admin;
    if (method === "GET" && path === "/v1/admin/accounts") return send(res, 200, { accounts: a.accounts(), deletions: a.deletions() });
    const acc = /^\/v1\/admin\/accounts\/(acct-[A-Za-z0-9_-]{22})(\/block|\/unblock|\/admin|\/devices\/([A-Za-z0-9_-]{4,80})\/revoke)?$/.exec(path);
    if (acc) {
      const id = acc[1]!;
      const sub = acc[2] ?? "";
      if (method === "GET" && !sub) {
        const account = a.account(id);
        if (!account) throw new HttpError(404, "no_such_account");
        return send(res, 200, { account, devices: a.devices(id), deletion: a.deletion(id) });
      }
      if (method === "POST" && sub === "/block") {
        if (id === s.accountId) throw new HttpError(409, "self_target");
        if (a.isAdmin(id) && a.adminCount() <= 1) throw new HttpError(409, "last_admin");
        a.block(id, String(((await json()) as { reason?: unknown })?.reason ?? ""), actor);
        this.endAccount(id);
        return send(res, 200, { account: a.account(id) });
      }
      if (method === "POST" && sub === "/unblock") return (a.unblock(id, actor), send(res, 200, { account: a.account(id) }));
      if (method === "POST" && sub === "/admin") {
        const b = (await json()) as { on?: unknown };
        if (typeof b?.on !== "boolean") throw new HttpError(400, "bad_on");
        // Granting or taking the flag: a fresh signature of this device (not only the session token).
        await this.auth.verifyAdminAction(s, b.on ? "admin-on" : "admin-off", id, b);
        a.setAdmin(id, b.on, actor, true);
        return send(res, 200, { account: a.account(id) });
      }
      if (method === "POST" && acc[3]) {
        const dev = acc[3];
        await this.auth.verifyAdminAction(s, "revoke-device", `${id}/${dev}`, await json());
        a.revokeDevice(id, dev, actor);
        this.notify.closeAccount(id, dev);
        return send(res, 200, { devices: a.devices(id) });
      }
      if (method === "DELETE" && !sub) {
        if (id === s.accountId) throw new HttpError(409, "self_target");
        await this.auth.verifyAdminAction(s, "delete-account", id, await json());
        const d = a.deleteAccount(id, actor);
        this.endAccount(id);
        this.seqs.delete(id);
        return send(res, 200, { deletion: d });
      }
    }
    if (path === "/v1/admin/invites") {
      if (method === "GET") return send(res, 200, { invites: this.invites.list() });
      if (method === "POST") {
        const b = (await json()) as { days?: unknown; note?: unknown };
        const days = b?.days === undefined ? 7 : Number(b.days);
        if (!Number.isFinite(days) || days <= 0 || days > 365) throw new HttpError(400, "bad_days");
        const note = typeof b?.note === "string" ? b.note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
        const inv = this.invites.create(Math.round(days * 24 * 3600_000), note, actor);
        a.log(actor, "invite.create", inv.id, { note, days });
        return send(res, 201, inv);
      }
    }
    if (method === "POST" && path === "/v1/admin/invites/revoke") {
      const ref = String(((await json()) as { ref?: unknown })?.ref ?? "");
      const inv = this.invites.revoke(ref);
      a.log(actor, "invite.revoke", inv.id, { note: inv.note });
      return send(res, 200, { invite: inv });
    }
    if (method === "GET" && path === "/v1/admin/instance") {
      const extra = Object.assign({}, ...this.extensions.map((x) => x.adminInfo?.() ?? {}));
      return send(res, 200, { ...extra, health: this.health(), accounts: a.accountCount(), admins: a.adminCount(), deletions: a.deletions(10) });
    }
    if (method === "PUT" && path === "/v1/admin/signup") {
      const p = String(((await json()) as { policy?: unknown })?.policy ?? "") as SignupPolicy;
      a.setSignup(p, actor);
      this.opts.onSignupChange?.(p);
      return send(res, 200, { signup: this.signup });
    }
    if (method === "GET" && path === "/v1/admin/doctor") {
      if (!this.opts.doctor) return send(res, 200, { checks: null });
      return send(res, 200, { checks: await this.opts.doctor() });
    }
    if (method === "GET" && path === "/v1/admin/log") {
      const action = url.searchParams.get("action") ?? undefined;
      if (action !== undefined && !/^[a-z_.]{1,40}$/.test(action)) throw new HttpError(400, "bad_action");
      return send(res, 200, { entries: a.logList({ limit: Math.min(intParam(url, "limit", ADMIN_LOG_PAGE), 500), before: intParam(url, "before", 0), action }) });
    }
    throw new HttpError(404, "not_found");
  }
}

export const ADMIN_LOG_PAGE = 100;

/** The page was served by this server (Origin host = Host header). */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function intParam(url: URL, name: string, dflt: number): number {
  const v = url.searchParams.get(name);
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `bad_${name}`);
  return n;
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  const req = (res as ServerResponse & { req?: IncomingMessage }).req;
  // A body we did not read (413): read and drop the rest, so the client finishes sending and
  // sees the response. Closing right away is not enough: on Windows a socket closed with unread
  // data is reset (RST) and the client gets ECONNRESET instead of the 413. Past DRAIN_CAP the
  // sender is not playing fair and the connection is dropped.
  const unread = req && !req.complete;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
    ...(unread ? { connection: "close" } : {}),
  });
  if (!unread) return void res.end(data);
  let drained = 0;
  req.on("data", (c: Buffer) => {
    drained += c.length;
    if (drained > DRAIN_CAP) req.socket.destroy();
  });
  req.once("end", () => res.end(data));
  req.once("error", () => res.destroy());
  req.resume();
}

/** How much of a refused body is still read so the 413 reaches the client (see send()). */
const DRAIN_CAP = 64 * 1024 * 1024;

async function readJson(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<unknown> {
  // Refuse early by declared length, without reading the body at all.
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "body_too_large");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, "body_too_large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

/** Only the plaintext fields the server may see, with strict shapes. */
function validateEnvelope(b: unknown, maxPayload = MAX_PAYLOAD_B64): EncryptedEnvelope {
  const e = b as Record<string, unknown>;
  if (!e || typeof e !== "object") throw new HttpError(400, "bad_envelope");
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "baseSeq,opId,payload,rulesVersion" && keys !== "baseSeq,leaseGuard,opId,payload,rulesVersion") throw new HttpError(400, "bad_envelope_fields");
  if (!isClientId(e.opId)) throw new HttpError(400, "bad_op_id");
  if (!Number.isInteger(e.rulesVersion)) throw new HttpError(400, "bad_rules_version");
  if (!Number.isInteger(e.baseSeq) || (e.baseSeq as number) < 0) throw new HttpError(400, "bad_base_seq");
  if (e.leaseGuard !== undefined && (!Array.isArray(e.leaseGuard) || e.leaseGuard.length > 1000 || !e.leaseGuard.every(isClientId))) {
    throw new HttpError(400, "bad_lease_guard");
  }
  if (typeof e.payload !== "string" || e.payload.length > maxPayload || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.payload)) throw new HttpError(400, "bad_payload");
  return {
    opId: e.opId as string,
    rulesVersion: e.rulesVersion as number,
    baseSeq: e.baseSeq as number,
    ...(e.leaseGuard !== undefined ? { leaseGuard: e.leaseGuard as string[] } : {}),
    payload: e.payload,
  };
}

export class ModeMismatchError extends Error {
  constructor(
    readonly stored: string,
    readonly wanted: string,
  ) {
    super(`this data directory belongs to a "${stored}" instance, not "${wanted}" (one instance = one mode; use another data directory)`);
    this.name = "ModeMismatchError";
  }
}

export { HttpError, send, readJson };
