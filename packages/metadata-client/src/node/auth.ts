// Server side of device sign-in (decision #13, koncept §3.3).
//
// Stores per account: the rescue public key, and per device: its Ed25519
// public key. Challenges are random, one-shot (deleted when used) and expire
// after CHALLENGE_TTL_MS. A successful login gives a random session token
// (stored as SHA-256) valid for sessionTtlMs. Revoking a device deletes its
// public key and all its sessions.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { authMessage, isPublicKey, isSignature, verifySignature, type Challenge } from "../device-key.js";

export const CHALLENGE_TTL_MS = 2 * 60_000;
export const DEFAULT_SESSION_TTL_MS = 60 * 60_000;
const MAX_OPEN_CHALLENGES = 10_000;

export interface Session {
  accountId: string;
  deviceId: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "AuthError";
  }
}

/** What DdnServer needs from authentication (swappable). */
export interface Authenticator {
  challenge(): Challenge;
  createAccount(body: unknown): Promise<{ accountId: string; deviceId: string }>;
  login(body: unknown): Promise<{ token: string; expiresAt: number; ttlMs: number }>;
  addDevice(s: Session, body: unknown): Promise<{ deviceId: string }>;
  rescueAddDevice(body: unknown): Promise<{ deviceId: string }>;
  revokeDevice(s: Session, deviceId: string, body: unknown): Promise<void>;
  listDevices(s: Session): { deviceId: string; publicKey: string; createdAt: number }[];
  verify(authorization: string | undefined): Session | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rid = (prefix: string) => `${prefix}-${randomBytes(16).toString("base64url")}`;
const ID_RE = /^[a-z]+-[A-Za-z0-9_-]{22}$/;

function obj(b: unknown): Record<string, unknown> {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new AuthError(400, "bad_body");
  return b as Record<string, unknown>;
}
function str(b: Record<string, unknown>, k: string, re = ID_RE): string {
  const v = b[k];
  if (typeof v !== "string" || !re.test(v)) throw new AuthError(400, `bad_${k}`);
  return v;
}
function pub(b: Record<string, unknown>, k: string): string {
  if (!isPublicKey(b[k])) throw new AuthError(400, `bad_${k}`);
  return b[k] as string;
}
function sig(b: Record<string, unknown>, k: string): string {
  if (!isSignature(b[k])) throw new AuthError(400, `bad_${k}`);
  return b[k] as string;
}

export class Ed25519Authenticator implements Authenticator {
  readonly instanceId: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, rescue_pub TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, added_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_device ON sessions(device_id);
    `);
    const row = db.prepare("SELECT v FROM server_meta WHERE k = 'instance'").get() as { v: string } | undefined;
    this.instanceId = row?.v ?? rid("inst");
    if (!row) db.prepare("INSERT INTO server_meta (k, v) VALUES ('instance', ?)").run(this.instanceId);
  }

  challenge(): Challenge {
    const t = this.now();
    this.db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(t);
    const open = (this.db.prepare("SELECT count(*) AS n FROM challenges").get() as { n: number }).n;
    if (open >= MAX_OPEN_CHALLENGES) throw new AuthError(429, "too_many_challenges");
    const c: Challenge = { challengeId: rid("chal"), nonce: randomBytes(32).toString("base64url"), instanceId: this.instanceId, expiresAt: t + CHALLENGE_TTL_MS };
    this.db.prepare("INSERT INTO challenges (id, nonce, expires_at) VALUES (?, ?, ?)").run(c.challengeId, c.nonce, c.expiresAt);
    return c;
  }

  /** One-shot: the challenge is gone after this call, whether the signature turns out good or not. */
  private take(challengeId: string): Challenge {
    const r = this.db.prepare("DELETE FROM challenges WHERE id = ? RETURNING nonce, expires_at").get(challengeId) as
      | { nonce: string; expires_at: number }
      | undefined;
    if (!r) throw new AuthError(401, "challenge_unknown");
    if (r.expires_at <= this.now()) throw new AuthError(401, "challenge_expired");
    return { challengeId, nonce: r.nonce, instanceId: this.instanceId, expiresAt: r.expires_at };
  }

  private async check(publicKey: string, message: string, signature: string): Promise<void> {
    if (!(await verifySignature(publicKey, message, signature))) throw new AuthError(401, "bad_signature");
  }

  private insertDevice(accountId: string, publicKey: string, addedBy: string): string {
    const deviceId = rid("dev");
    try {
      this.db.prepare("INSERT INTO devices (id, account_id, public_key, created_at, added_by) VALUES (?, ?, ?, ?, ?)").run(deviceId, accountId, publicKey, this.now(), addedBy);
    } catch {
      throw new AuthError(409, "public_key_in_use");
    }
    return deviceId;
  }

  async createAccount(body: unknown) {
    const b = obj(body);
    const c = this.take(str(b, "challengeId"));
    const devicePub = pub(b, "devicePublicKey");
    const rescuePub = pub(b, "rescuePublicKey");
    if (devicePub === rescuePub) throw new AuthError(400, "rescue_key_equals_device_key");
    const msg = authMessage.createAccount(c, devicePub, rescuePub);
    await this.check(devicePub, msg, sig(b, "deviceSignature"));
    await this.check(rescuePub, msg, sig(b, "rescueSignature"));
    const accountId = rid("acct");
    this.db.prepare("INSERT INTO accounts (id, rescue_pub, created_at) VALUES (?, ?, ?)").run(accountId, rescuePub, this.now());
    return { accountId, deviceId: this.insertDevice(accountId, devicePub, "create") };
  }

  async login(body: unknown) {
    const b = obj(body);
    const c = this.take(str(b, "challengeId"));
    const accountId = str(b, "accountId");
    const deviceId = str(b, "deviceId");
    const d = this.db.prepare("SELECT public_key FROM devices WHERE id = ? AND account_id = ?").get(deviceId, accountId) as { public_key: string } | undefined;
    // Same answer for unknown device and bad signature.
    if (!d || !(await verifySignature(d.public_key, authMessage.login(c, accountId, deviceId), sig(b, "signature")))) throw new AuthError(401, "bad_signature");
    const token = `dds_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + this.sessionTtlMs;
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now());
    this.db.prepare("INSERT INTO sessions (token_hash, account_id, device_id, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), accountId, deviceId, expiresAt);
    // ttlMs: clients time the session on their own clock (no clock-skew coupling).
    return { token, expiresAt, ttlMs: this.sessionTtlMs };
  }

  private devicePub(s: Session): string {
    const d = this.db.prepare("SELECT public_key FROM devices WHERE id = ? AND account_id = ?").get(s.deviceId, s.accountId) as { public_key: string } | undefined;
    if (!d) throw new AuthError(401, "device_revoked");
    return d.public_key;
  }

  /** Pairing: the signed-in device signs the new device's public key. */
  async addDevice(s: Session, body: unknown) {
    const b = obj(body);
    const c = this.take(str(b, "challengeId"));
    const newPub = pub(b, "devicePublicKey");
    await this.check(this.devicePub(s), authMessage.addDevice(c, s.accountId, newPub), sig(b, "signature"));
    return { deviceId: this.insertDevice(s.accountId, newPub, s.deviceId) };
  }

  /** Rescue kit: no session, signed with the rescue key derived from the account key. */
  async rescueAddDevice(body: unknown) {
    const b = obj(body);
    const c = this.take(str(b, "challengeId"));
    const accountId = str(b, "accountId");
    const newPub = pub(b, "devicePublicKey");
    const a = this.db.prepare("SELECT rescue_pub FROM accounts WHERE id = ?").get(accountId) as { rescue_pub: string } | undefined;
    if (!a || !(await verifySignature(a.rescue_pub, authMessage.rescueAddDevice(c, accountId, newPub), sig(b, "signature")))) throw new AuthError(401, "bad_signature");
    return { deviceId: this.insertDevice(accountId, newPub, "rescue") };
  }

  async revokeDevice(s: Session, deviceId: string, body: unknown) {
    const b = obj(body);
    const c = this.take(str(b, "challengeId"));
    await this.check(this.devicePub(s), authMessage.revokeDevice(c, s.accountId, deviceId), sig(b, "signature"));
    const r = this.db.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").run(deviceId, s.accountId);
    if (r.changes === 0) throw new AuthError(404, "no_such_device");
    this.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
  }

  listDevices(s: Session) {
    return (this.db.prepare("SELECT id, public_key, created_at FROM devices WHERE account_id = ? ORDER BY created_at, id").all(s.accountId) as {
      id: string;
      public_key: string;
      created_at: number;
    }[]).map((d) => ({ deviceId: d.id, publicKey: d.public_key, createdAt: d.created_at }));
  }

  verify(authorization: string | undefined): Session | null {
    const m = /^Bearer (dds_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!m) return null;
    const r = this.db
      .prepare("SELECT s.account_id, s.device_id, s.expires_at FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?")
      .get(sha256(m[1]!)) as { account_id: string; device_id: string; expires_at: number } | undefined;
    if (!r || r.expires_at <= this.now()) return null;
    return { accountId: r.account_id, deviceId: r.device_id };
  }
}
