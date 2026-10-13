// Server side of the optional password-protected account key (password-key.ts, koncept §3.8).
//
// Per account at most one row: login name (unique, case-folded), Argon2id parameters + salt,
// the account key sealed with the password wrap key, and SHA-256 of the auth proof. The server
// never sees the password, the wrap key or the account key.
//   POST /v1/auth/password/params {login}       -> {kdf}  (unknown login: stable fake parameters)
//   POST /v1/auth/password/key {login, proof}   -> {accountId, sealedKey} | 401 bad_password
//   GET/PUT/DELETE /v1/password-key (session)   state / turn on or change / turn off
// Attempts: per IP (DdnServer "password" bucket) and per account (PASSWORD_FAILS failures in
// PASSWORD_WINDOW_MS, then 429 until the window passes; a success clears the counter).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, type Session } from "./auth.js";
import { checkArgon2Params, normalizeLogin, PASSWORD_ARGON2, validLogin, type Argon2Params } from "../password-key.js";

export const PASSWORD_FAILS = 5;
export const PASSWORD_WINDOW_MS = 15 * 60_000;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class RateLimitedAuth extends Error {
  constructor(readonly retryAfterS: number) {
    super("rate_limited");
  }
}

export class PasswordKeyStore {
  private readonly fakeSecret: Buffer;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_keys (
        account_id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, kdf TEXT NOT NULL, sealed_key TEXT NOT NULL,
        verifier TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_fails (account_id TEXT PRIMARY KEY, since INTEGER NOT NULL, n INTEGER NOT NULL);
    `);
    const row = db.prepare("SELECT v FROM server_meta WHERE k = 'pw_fake_secret'").get() as { v: string } | undefined;
    if (row) this.fakeSecret = Buffer.from(row.v, "base64");
    else {
      this.fakeSecret = randomBytes(32);
      db.prepare("INSERT INTO server_meta (k, v) VALUES ('pw_fake_secret', ?)").run(this.fakeSecret.toString("base64"));
    }
  }

  private login(body: unknown): string {
    const l = normalizeLogin(String((body as { login?: unknown })?.login ?? ""));
    if (!validLogin(l)) throw new AuthError(400, "bad_login");
    return l;
  }

  private row(login: string) {
    return this.db.prepare("SELECT account_id, kdf, sealed_key, verifier FROM password_keys WHERE login = ?").get(login) as
      | { account_id: string; kdf: string; sealed_key: string; verifier: string }
      | undefined;
  }

  /** Parameters for a login; an unknown login gets stable fake ones (no account enumeration). */
  params(body: unknown): { kdf: Argon2Params } {
    const login = this.login(body);
    const r = this.row(login);
    if (r) return { kdf: JSON.parse(r.kdf) as Argon2Params };
    const salt = createHmac("sha256", this.fakeSecret).update(login).digest().subarray(0, 16).toString("base64");
    return { kdf: { alg: "argon2id", ...PASSWORD_ARGON2, saltB64: salt } };
  }

  /** The sealed account key for a correct proof. */
  key(body: unknown): { accountId: string; sealedKey: string } {
    const login = this.login(body);
    const proof = String((body as { proof?: unknown })?.proof ?? "");
    if (!B64.test(proof) || proof.length > 64) throw new AuthError(400, "bad_proof");
    const r = this.row(login);
    if (!r) throw new AuthError(401, "bad_password");
    const t = this.now();
    const f = this.db.prepare("SELECT since, n FROM password_fails WHERE account_id = ?").get(r.account_id) as { since: number; n: number } | undefined;
    const inWindow = f && t - f.since < PASSWORD_WINDOW_MS;
    if (inWindow && f.n >= PASSWORD_FAILS) throw new RateLimitedAuth(Math.ceil((f.since + PASSWORD_WINDOW_MS - t) / 1000));
    const got = createHash("sha256").update(Buffer.from(proof, "base64")).digest();
    const want = Buffer.from(r.verifier, "base64");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      if (inWindow) this.db.prepare("UPDATE password_fails SET n = n + 1 WHERE account_id = ?").run(r.account_id);
      else this.db.prepare("INSERT INTO password_fails (account_id, since, n) VALUES (?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET since = excluded.since, n = 1").run(r.account_id, t);
      throw new AuthError(401, "bad_password");
    }
    this.db.prepare("DELETE FROM password_fails WHERE account_id = ?").run(r.account_id);
    return { accountId: r.account_id, sealedKey: r.sealed_key };
  }

  status(s: Session): { enabled: boolean; login: string | null; updatedAt: number | null } {
    const r = this.db.prepare("SELECT login, updated_at FROM password_keys WHERE account_id = ?").get(s.accountId) as { login: string; updated_at: number } | undefined;
    return { enabled: !!r, login: r?.login ?? null, updatedAt: r?.updated_at ?? null };
  }

  /** Turn on, or change the password (same login or a new one). */
  put(s: Session, body: unknown): void {
    const b = body as { kdf?: unknown; sealedKey?: unknown; proof?: unknown };
    const login = this.login(body);
    let kdf: Argon2Params;
    try {
      kdf = checkArgon2Params(b?.kdf);
    } catch {
      throw new AuthError(400, "bad_kdf_params");
    }
    if (typeof b?.sealedKey !== "string" || !B64.test(b.sealedKey) || b.sealedKey.length > 200) throw new AuthError(400, "bad_sealed_key");
    if (typeof b?.proof !== "string" || !B64.test(b.proof) || Buffer.from(b.proof, "base64").length !== 32) throw new AuthError(400, "bad_proof");
    const other = this.db.prepare("SELECT account_id FROM password_keys WHERE login = ?").get(login) as { account_id: string } | undefined;
    if (other && other.account_id !== s.accountId) throw new AuthError(409, "login_taken");
    const verifier = createHash("sha256").update(Buffer.from(b.proof, "base64")).digest("base64");
    this.db
      .prepare(
        "INSERT INTO password_keys (account_id, login, kdf, sealed_key, verifier, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(account_id) DO UPDATE SET login = excluded.login, kdf = excluded.kdf, sealed_key = excluded.sealed_key, verifier = excluded.verifier, updated_at = excluded.updated_at",
      )
      .run(s.accountId, login, JSON.stringify(kdf), b.sealedKey, verifier, this.now());
    this.db.prepare("DELETE FROM password_fails WHERE account_id = ?").run(s.accountId);
  }

  /** Turn off: the sealed key and the verifier are deleted from the server. */
  remove(s: Session): void {
    this.db.prepare("DELETE FROM password_keys WHERE account_id = ?").run(s.accountId);
    this.db.prepare("DELETE FROM password_fails WHERE account_id = ?").run(s.accountId);
  }
}
