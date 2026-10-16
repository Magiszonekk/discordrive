// Invite codes for a public instance (B): sign-up is
// closed by default; the operator hands out one-shot codes made by
// `discordrive setup` / `discordrive invite`. The server keeps only the
// SHA-256 of a code. A code is claimed atomically before the account is
// created and released again if creation fails.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
// Crockford base32 without I, L, O, U: easy to read aloud and type on a phone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "ddn-inv-";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Canonical form: prefix + 16 chars, case and separators ignored. Null if it cannot be a code. */
export function normalizeInvite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let t = input.replace(/[\s_-]/g, "").toUpperCase();
  if (t.startsWith("DDNINV")) t = t.slice(6);
  t = t.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(t)) return null;
  return PREFIX + t;
}

function format(c: string): string {
  const body = c.slice(PREFIX.length);
  return PREFIX + body.match(/.{4}/g)!.join("-");
}

export interface InviteInfo {
  /** Short public ID of the code (start of its hash): lists, revoking. Not the code. */
  id: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  /** Account created with the code (null while unused). */
  usedBy: string | null;
  revokedAt: number | null;
  note: string;
  /** "operator" (CLI/setup) or the admin account that made it. */
  createdBy: string;
  state: "active" | "used" | "expired" | "revoked";
}

/** Tables of invite codes (also opened by the operator CLI). */
export function inviteTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS invites (
    code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT, note TEXT NOT NULL DEFAULT '')`);
  const cols = (db.prepare("PRAGMA table_info(invites)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("revoked_at")) db.exec("ALTER TABLE invites ADD COLUMN revoked_at INTEGER");
  if (!cols.includes("created_by")) db.exec("ALTER TABLE invites ADD COLUMN created_by TEXT NOT NULL DEFAULT 'operator'");
}

/** Length of the public invite ID (hex chars of the code hash). */
const ID_LEN = 10;

export class InviteStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    inviteTables(db);
  }

  /** New one-shot code (printed once, stored hashed). */
  create(ttlMs = DEFAULT_INVITE_TTL_MS, note = "", createdBy = "operator"): { code: string; expiresAt: number; id: string } {
    const b = randomBytes(16);
    let body = "";
    for (let i = 0; i < 16; i++) body += ALPHABET[b[i]! & 31];
    const code = PREFIX + body;
    const t = this.now();
    const h = hash(code);
    this.db.prepare("INSERT INTO invites (code_hash, created_at, expires_at, note, created_by) VALUES (?, ?, ?, ?, ?)").run(h, t, t + ttlMs, note.slice(0, 200), createdBy);
    return { code: format(code), expiresAt: t + ttlMs, id: h.slice(0, ID_LEN) };
  }

  /** Atomically mark the code used. False if unknown, used or expired. */
  claim(input: unknown): string | null {
    const c = normalizeInvite(input);
    if (!c) return null;
    const r = this.db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").run(this.now(), hash(c), this.now());
    return r.changes === 1 ? c : null;
  }

  /** Account creation failed after the claim: give the code back. */
  release(code: string): void {
    this.db.prepare("UPDATE invites SET used_at = NULL, used_by = NULL WHERE code_hash = ?").run(hash(code));
  }

  markUsedBy(code: string, accountId: string): void {
    this.db.prepare("UPDATE invites SET used_by = ? WHERE code_hash = ?").run(accountId, hash(code));
  }

  list(): InviteInfo[] {
    const t = this.now();
    return (this.db.prepare("SELECT code_hash, created_at, expires_at, used_at, used_by, revoked_at, note, created_by FROM invites ORDER BY created_at, code_hash").all() as {
      code_hash: string;
      created_at: number;
      expires_at: number;
      used_at: number | null;
      used_by: string | null;
      revoked_at: number | null;
      note: string;
      created_by: string;
    }[]).map((r) => ({
      id: r.code_hash.slice(0, ID_LEN),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      usedBy: r.used_by,
      revokedAt: r.revoked_at,
      note: r.note,
      createdBy: r.created_by,
      state: r.revoked_at !== null ? "revoked" : r.used_at !== null ? "used" : r.expires_at <= t ? "expired" : "active",
    }));
  }

  /**
   * Revoke an unused code, given as the code itself or as (a unique prefix of) its ID.
   * Returns the revoked invite; throws InviteError when nothing or several match, or it was used.
   */
  revoke(codeOrId: string): InviteInfo {
    const code = normalizeInvite(codeOrId);
    const q = String(codeOrId).trim().toLowerCase();
    let rows: { code_hash: string }[];
    if (code) rows = this.db.prepare("SELECT code_hash FROM invites WHERE code_hash = ?").all(hash(code)) as never;
    else if (/^[0-9a-f]{4,64}$/.test(q)) rows = this.db.prepare("SELECT code_hash FROM invites WHERE code_hash LIKE ?").all(`${q}%`) as never;
    else throw new InviteError("bad_invite_ref");
    if (rows.length === 0) throw new InviteError("no_such_invite");
    if (rows.length > 1) throw new InviteError("ambiguous_invite");
    const h = rows[0]!.code_hash;
    const info = this.list().find((x) => x.id === h.slice(0, ID_LEN))!;
    if (info.state === "used") throw new InviteError("invite_used");
    if (info.state !== "revoked") this.db.prepare("UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND used_at IS NULL").run(this.now(), h);
    return this.list().find((x) => x.id === info.id)!;
  }

  /** Note of the code an account was created with ("" when none or open sign-up). */
  noteOf(accountId: string): string | null {
    const r = this.db.prepare("SELECT note FROM invites WHERE used_by = ?").get(accountId) as { note: string } | undefined;
    return r ? r.note : null;
  }
}

export class InviteError extends Error {
  constructor(readonly code: "bad_invite_ref" | "no_such_invite" | "ambiguous_invite" | "invite_used") {
    super(code);
    this.name = "InviteError";
  }
}
