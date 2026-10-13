// Share links in metadata-only mode (koncept §3.7).
//
// The owner's client registers the attachment addresses (channel ID,
// attachment ID, file name) of ONE file's manifest and fragments, plus an
// opaque blob sealed with that file's key (name, size; the server cannot read
// it). The file key travels only in the link after '#': /s/<id>#<key>.
// A recipient asks for fresh CDN links; the server refreshes them with the
// instance bot (POST /attachments/refresh-urls; the bot needs no access to
// the owner's server) and caches them until shortly before they expire.
//
// The server learns only the attachment addresses of shared files. Revoking
// stops new recipients here; whoever already has the addresses and the key
// keeps access while the fragments exist (§3.7, documented in the UI).

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, type Session } from "./auth.js";

export const MAX_SHARE_ATTACHMENTS = 5000;
const SNOWFLAKE = /^\d{15,22}$/;
const FILENAME = /^[A-Za-z0-9_.-]{1,128}$/;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const CDN = "https://cdn.discordapp.com/attachments";

export interface BotRefresher {
  /** Refresh up to 50 CDN attachment URLs; returns fresh signed URLs in the same order. */
  refresh(urls: string[]): Promise<string[]>;
}

/** The instance bot over the real Discord API. The token never leaves this object. */
export class DiscordBotRefresher implements BotRefresher {
  readonly #token: string;
  constructor(
    token: string,
    private readonly apiOrigin = "https://discord.com",
    private readonly f: typeof fetch = (...a) => fetch(...a),
  ) {
    this.#token = token;
  }
  async refresh(urls: string[]): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.f(`${this.apiOrigin}/api/v10/attachments/refresh-urls`, {
        method: "POST",
        headers: { authorization: `Bot ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify({ attachment_urls: urls }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 429 && attempt < 3) {
        const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((res) => setTimeout(res, Math.min(10_000, (j.retry_after ?? 1) * 1000)));
        continue;
      }
      if (!r.ok) throw new Error(`refresh-urls: HTTP ${r.status}`);
      const j = (await r.json()) as { refreshed_urls?: { original: string; refreshed: string }[] };
      const map = new Map((j.refreshed_urls ?? []).map((x) => [x.original.split("?")[0], x.refreshed]));
      return urls.map((u) => {
        const v = map.get(u.split("?")[0]);
        if (!v) throw new Error("refresh-urls: missing url");
        return v;
      });
    }
  }
}

/** Check a token against Discord without printing it: GET /users/@me. */
export async function checkBotToken(token: string, apiOrigin = "https://discord.com"): Promise<{ ok: true; id: string; username: string } | { ok: false; status: number }> {
  const r = await fetch(`${apiOrigin}/api/v10/users/@me`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return { ok: false, status: r.status };
  const j = (await r.json()) as { id: string; username: string; bot?: boolean };
  return { ok: true, id: j.id, username: j.username };
}

interface Att {
  c: string;
  a: string;
  f: string;
}

export class ShareStore {
  private readonly cache = new Map<string, { url: string; until: number }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly bot: BotRefresher | null,
    private readonly cdnOrigins: string[] = [],
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      meta TEXT NOT NULL, owner_note TEXT NOT NULL, atts TEXT NOT NULL, revoked_at INTEGER)`);
    db.exec("CREATE INDEX IF NOT EXISTS shares_account ON shares(account_id)");
  }

  get available(): boolean {
    return !!this.bot;
  }

  create(s: Session, body: unknown): { shareId: string } {
    if (!this.bot) throw new AuthError(503, "shares_unavailable");
    const b = body as { attachments?: unknown; meta?: unknown; ownerNote?: unknown };
    if (!Array.isArray(b?.attachments) || b.attachments.length < 2 || b.attachments.length > MAX_SHARE_ATTACHMENTS) throw new AuthError(400, "bad_attachments");
    const atts: Att[] = b.attachments.map((x: unknown) => {
      const o = x as Record<string, unknown>;
      if (!o || !SNOWFLAKE.test(String(o.channelId)) || !SNOWFLAKE.test(String(o.attachmentId)) || !FILENAME.test(String(o.filename))) throw new AuthError(400, "bad_attachment");
      return { c: String(o.channelId), a: String(o.attachmentId), f: String(o.filename) };
    });
    for (const k of ["meta", "ownerNote"] as const) {
      const v = b[k];
      if (typeof v !== "string" || v.length > 4096 || !B64.test(v)) throw new AuthError(400, `bad_${k}`);
    }
    const id = randomBytes(16).toString("base64url");
    this.db
      .prepare("INSERT INTO shares (id, account_id, created_at, meta, owner_note, atts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, s.accountId, this.now(), b.meta as string, b.ownerNote as string, JSON.stringify(atts));
    return { shareId: id };
  }

  list(s: Session): { shareId: string; createdAt: number; ownerNote: string; revoked: boolean }[] {
    return (this.db.prepare("SELECT id, created_at, owner_note, revoked_at FROM shares WHERE account_id = ? ORDER BY created_at DESC").all(s.accountId) as {
      id: string;
      created_at: number;
      owner_note: string;
      revoked_at: number | null;
    }[]).map((r) => ({ shareId: r.id, createdAt: r.created_at, ownerNote: r.owner_note, revoked: r.revoked_at !== null }));
  }

  revoke(s: Session, id: string): void {
    const r = this.db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").run(this.now(), id, s.accountId);
    if (r.changes === 0) throw new AuthError(404, "no_such_share");
  }

  private row(id: string): { meta: string; atts: Att[] } {
    const r = this.db.prepare("SELECT meta, atts, revoked_at FROM shares WHERE id = ?").get(id) as { meta: string; atts: string; revoked_at: number | null } | undefined;
    if (!r || r.revoked_at !== null) throw new AuthError(404, "no_such_share");
    return { meta: r.meta, atts: JSON.parse(r.atts) as Att[] };
  }

  get(id: string): { meta: string; count: number } {
    const r = this.row(id);
    return { meta: r.meta, count: r.atts.length };
  }

  /** Fresh CDN URLs for attachments [from, from+n). Index 0 = manifest. */
  async urls(id: string, from: number, n: number): Promise<{ from: number; urls: string[] }> {
    if (!this.bot) throw new AuthError(503, "shares_unavailable");
    const { atts } = this.row(id);
    const slice = atts.slice(from, from + n);
    const t = this.now();
    const raw = slice.map((x) => `${CDN}/${x.c}/${x.a}/${x.f}`);
    const missing = raw.filter((u) => !((this.cache.get(u)?.until ?? 0) > t));
    for (let i = 0; i < missing.length; i += 50) {
      const part = missing.slice(i, i + 50);
      const fresh = await this.bot.refresh(part);
      part.forEach((u, k) => {
        const url = fresh[k]!;
        if (!this.allowedCdn(url)) throw new AuthError(502, "bad_refreshed_url");
        this.cache.set(u, { url, until: t + this.ttlOf(url, t) });
      });
    }
    if (this.cache.size > 50_000) for (const [k, v] of this.cache) if (v.until <= t) this.cache.delete(k);
    return { from, urls: raw.map((u) => this.cache.get(u)!.url) };
  }

  /**
   * Forget cached links (e2ee/plain: after a channel move deleted the old messages, a cached link of
   * an old attachment would 404; the next request refreshes through the instance, which resolves it).
   */
  dropCache(): void {
    this.cache.clear();
  }

  private allowedCdn(u: string): boolean {
    try {
      const o = new URL(u).origin;
      return o === "https://cdn.discordapp.com" || o === "https://media.discordapp.net" || this.cdnOrigins.includes(o);
    } catch {
      return false;
    }
  }

  /** Cache until 1 h before the link's own expiry (ex=hex seconds), at most 12 h. */
  private ttlOf(u: string, t: number): number {
    const ex = parseInt(new URL(u).searchParams.get("ex") ?? "", 16);
    const left = Number.isFinite(ex) ? ex * 1000 - t - 3600_000 : 0;
    return Math.max(0, Math.min(12 * 3600_000, left));
  }
}
