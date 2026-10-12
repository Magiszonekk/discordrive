// discordrive-next metadata-only server (koncept §3.4): arbiter of the
// encrypted operation log, webhook vault storage, upload leases.
// Sees only what §3.3 allows: account/devices, opId, rulesVersion, baseSeq,
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
import { RULES_VERSION, Sequencer, isClientId } from "@ddv4/sync-core";
import type { EncryptedEntry, EncryptedEnvelope } from "../op-crypto.js";
import { PAIRING_TTL_MS } from "../pairing.js";
import { AuthError, Ed25519Authenticator, type Authenticator, type Session } from "./auth.js";
import { InviteStore } from "./invites.js";
import { IpLimiter, clientIp, type BucketSpec } from "./ip-limit.js";
import { NotifyHub } from "./notify.js";
import { ShareStore, type BotRefresher } from "./shares.js";
import { StaticSite, type StaticOptions } from "./static.js";

export type { Authenticator, Session };

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_PAYLOAD_B64 = 1024 * 1024;
export const MAX_VAULT_B64 = 512 * 1024;
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
export const DEFAULT_RATE_LIMITS: Record<"auth" | "signup" | "mailbox" | "share", BucketSpec> = {
  auth: { burst: 60, perMin: 60 },
  signup: { burst: 5, perMin: 2 },
  mailbox: { burst: 60, perMin: 90 },
  share: { burst: 60, perMin: 120 },
};
const MAX_WAIT_S = 30;

export interface ServerOptions {
  dbPath?: string;
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
  /** Instance bot for share links (§3.7). Without it shares answer 503. */
  bot?: BotRefresher;
  /** Allowed CDN origin of shared attachments (tests: the fake Discord). */
  cdnOrigins?: string[];
  mode?: string;
  /** Default language of the web app for this instance (users can switch). */
  language?: string;
  /** Browser origins allowed via CORS (exact match). Default: none. */
  corsOrigins?: string[];
  /** Session token lifetime (default 1 h). */
  sessionTtlMs?: number;
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
  private readonly limits: ServerLimits;
  private readonly signup: "open" | "invite" | "closed";
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
      CREATE TABLE IF NOT EXISTS pairing (id TEXT PRIMARY KEY, msg TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    this.auth = new Ed25519Authenticator(this.db, this.now, opts.sessionTtlMs);
    this.notify = new NotifyHub(this.now);
    this.invites = new InviteStore(this.db, this.now);
    this.shares = new ShareStore(this.db, this.now, opts.bot ?? null, opts.cdnOrigins);
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.signup = opts.signup ?? (opts.openSignup === false ? "closed" : "open");
    if (opts.rateLimits !== false) {
      const spec = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
      for (const k of Object.keys(spec) as (keyof typeof spec)[]) this.ipLimits[k] = new IpLimiter(spec[k], this.now);
    }
    this.web = opts.web ? new StaticSite(opts.web) : null;
    this.startedAt = this.now();
  }

  health() {
    return {
      ok: true,
      service: "discordrive-next",
      version: SERVER_VERSION,
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
        minRulesVersion: this.opts.minRulesVersion ?? RULES_VERSION,
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
    return this.seq(s.accountId).renewLease(uploadId, s.deviceId);
  }
  releaseLease(s: Session, uploadId: string): void {
    this.seq(s.accountId).releaseLease(uploadId, s.deviceId);
  }

  getVault(s: Session): { revision: number; blob: string } | null {
    return (this.db.prepare("SELECT revision, blob FROM vault WHERE account_id = ?").get(s.accountId) as { revision: number; blob: string } | undefined) ?? null;
  }

  putVault(s: Session, body: unknown): { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } {
    const b = body as { expectedRevision?: unknown; revision?: unknown; blob?: unknown };
    if (!Number.isInteger(b?.expectedRevision) || !Number.isInteger(b?.revision) || typeof b?.blob !== "string") throw new HttpError(400, "bad_vault");
    if ((b.blob as string).length > this.limits.vaultB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.blob as string)) throw new HttpError(400, "bad_vault_blob");
    const exp = b.expectedRevision as number;
    const rev = b.revision as number;
    let out: { status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null } = { status: "ok" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.getVault(s);
      if ((cur?.revision ?? 0) !== exp || rev !== exp + 1) out = { status: "conflict", current: cur };
      else
        this.db
          .prepare("INSERT INTO vault (account_id, revision, blob) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision, blob = excluded.blob")
          .run(s.accountId, rev, b.blob as string);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  // --- pairing mailbox (§3.8): one opaque message per pairingId, deleted on read, 10 min TTL.
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
        const he = e instanceof HttpError ? e : e instanceof AuthError ? new HttpError(e.status, e.code) : new HttpError(500, "internal");
        if (!(e instanceof HttpError) && !(e instanceof AuthError)) console.error("ddn-server:", (e as Error)?.message);
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

    if (!path.startsWith("/v1/")) {
      if (this.web?.handle(req, res, path)) return;
      throw new HttpError(404, "not_found");
    }
    const json = () => readJson(req, this.limits.bodyBytes);

    if (method === "GET" && path === "/v1/health") return send(res, 200, this.health());
    if (method === "POST" && path === "/v1/auth/challenge") return (this.limit("auth", req), send(res, 200, this.auth.challenge()));
    if (method === "POST" && path === "/v1/auth/login") return (this.limit("auth", req), send(res, 200, await this.auth.login(await json())));
    if (method === "POST" && path === "/v1/auth/rescue-device") return (this.limit("signup", req), send(res, 201, await this.auth.rescueAddDevice(await json())));
    if (method === "POST" && path === "/v1/accounts") {
      this.limit("signup", req);
      if (this.signup === "closed") throw new HttpError(403, "signup_closed");
      const body = await json();
      if (this.signup === "open") return send(res, 201, await this.auth.createAccount(body));
      const code = this.invites.claim((body as { invite?: unknown } | null)?.invite);
      if (!code) throw new HttpError(403, "invite_required");
      try {
        const r = await this.auth.createAccount(body);
        this.invites.markUsedBy(code, r.accountId);
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
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/v1/shares") return send(res, 201, this.shares.create(s, await json()));
    if (method === "GET" && path === "/v1/shares") return send(res, 200, { shares: this.shares.list(s) });
    if (share && !share[2] && method === "DELETE") return (this.shares.revoke(s, share[1]!), send(res, 200, { ok: true }));
    throw new HttpError(404, "not_found");
  }
}

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
  // A body we did not read (413): close the connection after answering, and
  // drain the rest so the client sees the response instead of ECONNRESET.
  const unread = req && !req.complete;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
    ...(unread ? { connection: "close" } : {}),
  });
  res.end(data);
  if (unread) req.resume();
}

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

/** Only the plaintext fields the server may see, with strict shapes (§3.3). */
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

export { HttpError };
