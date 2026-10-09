// Invite codes for a public instance (zlecenie 2026-10-09 B): sign-up is
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
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  note: string;
}

export class InviteStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      used_at INTEGER, used_by TEXT, note TEXT NOT NULL DEFAULT '')`);
  }

  /** New one-shot code (printed once, stored hashed). */
  create(ttlMs = DEFAULT_INVITE_TTL_MS, note = ""): { code: string; expiresAt: number } {
    const b = randomBytes(16);
    let body = "";
    for (let i = 0; i < 16; i++) body += ALPHABET[b[i]! & 31];
    const code = PREFIX + body;
    const t = this.now();
    this.db.prepare("INSERT INTO invites (code_hash, created_at, expires_at, note) VALUES (?, ?, ?, ?)").run(hash(code), t, t + ttlMs, note.slice(0, 200));
    return { code: format(code), expiresAt: t + ttlMs };
  }

  /** Atomically mark the code used. False if unknown, used or expired. */
  claim(input: unknown): string | null {
    const c = normalizeInvite(input);
    if (!c) return null;
    const r = this.db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(this.now(), hash(c), this.now());
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
    return (this.db.prepare("SELECT created_at, expires_at, used_at, note FROM invites ORDER BY created_at").all() as {
      created_at: number;
      expires_at: number;
      used_at: number | null;
      note: string;
    }[]).map((r) => ({ createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, note: r.note }));
  }
}
