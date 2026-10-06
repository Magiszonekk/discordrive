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
// Auth is behind `Authenticator`. Until the owner decides §8.4 (ask-owner #13)
// it is a random bearer token per device, stored as SHA-256.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { RULES_VERSION, Sequencer, isClientId } from "@ddv4/sync-core";
import type { EncryptedEntry, EncryptedEnvelope } from "../op-crypto.js";
import { PAIRING_TTL_MS } from "../pairing.js";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_PAYLOAD_B64 = 1024 * 1024;
export const MAX_VAULT_B64 = 512 * 1024;
const MAX_WAIT_S = 30;

export interface ServerOptions {
  dbPath?: string;
  now?: () => number;
  leaseMs?: number;
  minRulesVersion?: number;
  maxRulesVersion?: number;
  /** Allow POST /v1/accounts (account creation). Default true; a real instance gates it. */
  openSignup?: boolean;
  /** Browser origins allowed via CORS (exact match). Default: none. */
  corsOrigins?: string[];
}

export interface Session {
  accountId: string;
  deviceId: string;
}

/** Pluggable authentication (§8.4 pending). */
export interface Authenticator {
  /** Credential for a new device. */
  issue(accountId: string, deviceId: string): string;
  verify(header: string | undefined): Session | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rid = (prefix: string) => `${prefix}-${randomBytes(16).toString("base64url")}`;

export class DdnServer {
  readonly db: DatabaseSync;
  private readonly seqs = new Map<string, Sequencer<EncryptedEnvelope>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  readonly auth: Authenticator;
  private http: Server | null = null;

  constructor(private readonly opts: ServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.db = new DatabaseSync(opts.dbPath ?? ":memory:");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS log (
        account_id TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT NOT NULL, entry TEXT NOT NULL,
        PRIMARY KEY (account_id, seq), UNIQUE (account_id, op_id));
      CREATE TABLE IF NOT EXISTS vault (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, blob TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing (id TEXT PRIMARY KEY, msg TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    const db = this.db;
    this.auth = {
      issue(accountId, deviceId) {
        const token = `ddt_${randomBytes(32).toString("base64url")}`;
        db.prepare("INSERT INTO devices (id, account_id, token_hash, created_at) VALUES (?, ?, ?, ?)").run(deviceId, accountId, sha256(token), Date.now());
        return token;
      },
      verify(header) {
        const m = /^Bearer (ddt_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
        if (!m) return null;
        const r = db.prepare("SELECT id, account_id FROM devices WHERE token_hash = ? AND revoked = 0").get(sha256(m[1]!)) as
          | { id: string; account_id: string }
          | undefined;
        return r ? { accountId: r.account_id, deviceId: r.id } : null;
      },
    };
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

  createAccount(): { accountId: string; deviceId: string; token: string } {
    const accountId = rid("acct");
    const deviceId = rid("dev");
    this.db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run(accountId, this.now());
    return { accountId, deviceId, token: this.auth.issue(accountId, deviceId) };
  }

  /** Register another device of the same account (pairing, §3.8, will authorise this). */
  addDevice(s: Session): { deviceId: string; token: string } {
    const deviceId = rid("dev");
    return { deviceId, token: this.auth.issue(s.accountId, deviceId) };
  }

  revokeDevice(s: Session, deviceId: string): void {
    this.db.prepare("UPDATE devices SET revoked = 1 WHERE id = ? AND account_id = ?").run(deviceId, s.accountId);
  }

  submit(s: Session, body: unknown) {
    const env = validateEnvelope(body);
    const sq = this.seq(s.accountId);
    const r = sq.submit(env, s.deviceId);
    if (r.status === "accepted") {
      this.db.prepare("INSERT INTO log (account_id, seq, op_id, entry) VALUES (?, ?, ?, ?)").run(s.accountId, r.entry.seq, r.entry.opId, JSON.stringify(r.entry));
      for (const w of this.waiters.get(s.accountId) ?? []) w();
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
    if ((b.blob as string).length > MAX_VAULT_B64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.blob as string)) throw new HttpError(400, "bad_vault_blob");
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
        const he = e instanceof HttpError ? e : new HttpError(500, "internal");
        if (!(e instanceof HttpError)) console.error("ddn-server:", (e as Error)?.message);
        send(res, he.status, { error: he.code });
      });
    });
    await new Promise<void>((r) => this.http!.listen(port, host, r));
    const addr = this.http.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    return { url: `http://${host}:${p}`, port: p };
  }

  async close(): Promise<void> {
    for (const set of this.waiters.values()) for (const w of [...set]) w();
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

    if (method === "POST" && path === "/v1/accounts") {
      if (this.opts.openSignup === false) throw new HttpError(403, "signup_closed");
      return send(res, 201, this.createAccount());
    }
    if (method === "GET" && path === "/v1/health") return send(res, 200, { ok: true, rulesVersion: RULES_VERSION });
    const pair = /^\/v1\/pairing\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (pair && method === "GET") {
      const m = this.pairingTake(pair[1]!);
      return m ? send(res, 200, m) : send(res, 404, { error: "no_pairing_message" });
    }

    const s = this.auth.verify(req.headers.authorization);
    if (!s) throw new HttpError(401, "unauthorized");

    if (method === "POST" && path === "/v1/log") return send(res, 200, this.submit(s, await readJson(req)));
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
        const v = this.getVault(s);
        return v ? send(res, 200, v) : send(res, 404, { error: "no_vault" });
      }
      if (method === "PUT") {
        const r = this.putVault(s, await readJson(req));
        return send(res, r.status === "ok" ? 200 : 409, r);
      }
    }
    if (method === "POST" && path === "/v1/devices") return send(res, 201, this.addDevice(s));
    if (pair && method === "PUT") return (this.pairingPut(s, pair[1]!, await readJson(req)), send(res, 201, { ok: true }));
    const dev = /^\/v1\/devices\/([A-Za-z0-9_-]{4,80})$/.exec(path);
    if (dev && method === "DELETE") return (this.revokeDevice(s, dev[1]!), send(res, 200, { ok: true }));
    throw new HttpError(404, "not_found");
  }
}

function intParam(url: URL, name: string, dflt: number): number {
  const v = url.searchParams.get(name);
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `bad_${name}`);
  return n;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  const req = (res as ServerResponse & { req?: IncomingMessage }).req;
  // A body we did not read (413): close the connection after answering, and
  // drain the rest so the client sees the response instead of ECONNRESET.
  const unread = req && !req.complete;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...(unread ? { connection: "close" } : {}),
  });
  res.end(data);
  if (unread) req.resume();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Refuse early by declared length, without reading the body at all.
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

/** Only the plaintext fields the server may see, with strict shapes (§3.3). */
function validateEnvelope(b: unknown): EncryptedEnvelope {
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
  if (typeof e.payload !== "string" || e.payload.length > MAX_PAYLOAD_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.payload)) throw new HttpError(400, "bad_payload");
  return {
    opId: e.opId as string,
    rulesVersion: e.rulesVersion as number,
    baseSeq: e.baseSeq as number,
    ...(e.leaseGuard !== undefined ? { leaseGuard: e.leaseGuard as string[] } : {}),
    payload: e.payload,
  };
}
