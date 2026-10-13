// Blobs through the instance: the server part of the e2ee and plain modes
// (docs/stage3-modes.md §3, §5, §6). A DdnServer extension.
//
// Endpoints (all need a session; the account comes from it):
//   PUT    /v1/uploads/<U>/blobs/<i>  one ciphertext blob (fragment i or "m" = manifest), body =
//                                     bytes, x-ddn-sha256 = hex SHA-256. Needs this device's
//                                     lease on U (rule 8). Same (U, i, hash) again = the stored
//                                     placement, nothing posted twice (resume).
//   GET    /v1/uploads/<U>            state + stored blob indexes (resume after a restart)
//   POST   /v1/uploads/<U>/final      all blobs stored, commit follows: never cleaned as abandoned
//   DELETE /v1/uploads/<U>            cancel: blobs deleted, U refused from now on (tombstone)
//   POST   /v1/uploads/released       client reports released uploads (purged/superseded
//                                     versions, from its index): deleted 30 days later
//   POST   /v1/blobs/urls             fresh CDN links (≤ 50) of this account's blobs
//   POST   /v1/blobs/describe         channel + filename of this account's blobs (share links)
//   GET    /v1/blobs/<attachmentId>   the bytes through the instance (fallback when the CDN
//                                     cannot be read from the browser)
//   GET|POST|DELETE /v1/channels[/id] the account's own channels (Settings -> Channels)
//
// Memory (lesson of fix/upload-cancel-and-oom): a blob is read into one buffer of its
// declared size only after a slot of the in-flight byte budget is free; until then the
// body is not read at all, so TCP backpressure holds the client and RAM does not grow with
// the number of uploaders.
//
// Background (no browser tab needed): abandoned uploads (lease expired, not final) are
// deleted, released ones after FRAGMENT_RETENTION_MS, webhooks are health-checked.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isClientId } from "@ddv4/sync-core";
import { BLOB_EXT, type DiscordPlacement } from "@ddv4/metadata-client";
import { HttpError, type DdnServer, type ExtRequest, type ServerExtension, type BotRefresher } from "@ddv4/metadata-client/node";
import { DiscordSender, DiscordUnavailableError, NoChannelError, type SenderHook } from "./sender.js";
import { InstanceHooks, POOL } from "./instance-hooks.js";

/** Largest blob accepted (a fragment is 10 MiB incl. IV + tag; a manifest of 1327 fragments ~160 KB). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024 + 64 * 1024;
export const DEFAULT_INFLIGHT_BYTES = 192 * 1024 * 1024;
export const FRAGMENT_RETENTION_MS = 30 * 24 * 3600_000;
export const HEALTH_EVERY_MS = 15 * 60_000;
const CDN = "https://cdn.discordapp.com/attachments";
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * open      blobs may arrive (lease held)            final     client said "all stored, committing"
 * committed the log has a second entry guarded by U  (upload_commit or upload_abort: rule 8 puts
 *           every op touching U in the plaintext leaseGuard, so the server sees it without reading)
 * aborted   cancelled by the client                  reaped    abandoned, cleaned by the server
 * released  reported purged/superseded by a client   purged    released + retention passed, deleted
 * aborted/reaped are tombstones: the lease of U is refused from then on, so U can never be committed.
 */
type UploadState = "open" | "final" | "committed" | "aborted" | "reaped" | "released" | "purged";

/** Bytes in flight, FIFO: a waiter is woken only with its bytes already reserved for it. */
export class ByteBudget {
  private used = 0;
  private readonly queue: { n: number; go: () => void }[] = [];
  peak = 0;
  constructor(readonly limit: number) {}
  get inUse(): number {
    return this.used;
  }
  get waiting(): number {
    return this.queue.length;
  }
  async acquire(n: number): Promise<() => void> {
    n = Math.min(n, this.limit);
    if (!this.queue.length && this.used + n <= this.limit) this.used += n;
    else await new Promise<void>((go) => this.queue.push({ n, go })); // the releaser reserves n
    this.peak = Math.max(this.peak, this.used);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.used -= n;
      while (this.queue.length && this.used + this.queue[0]!.n <= this.limit) {
        const w = this.queue.shift()!;
        this.used += w.n;
        w.go();
      }
    };
  }
}

export interface BlobsExtensionOptions {
  hooks: InstanceHooks;
  sender: DiscordSender;
  /** Instance bot (refresh-urls); without it links are refreshed through the webhooks. */
  bot?: BotRefresher | null;
  inflightBytes?: number;
  /** Background tick (ms); 0 = no timer (tests call tick()). */
  tickMs?: number;
  /** Abandoned = no lease and no activity for this long (default: the lease time, 10 min). */
  abandonAfterMs?: number;
  retentionMs?: number;
  /** Allowed CDN origins of refreshed links (tests: the fake Discord). */
  cdnOrigins?: string[];
  /** Called after a final upload's blobs are stored (plain: thumbnails). */
  log?: (s: string) => void;
}

export class BlobsExtension implements ServerExtension {
  readonly name = "server-blobs";
  srv!: DdnServer;
  private db!: DatabaseSync;
  readonly budget: ByteBudget;
  private readonly links = new Map<string, { url: string; until: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHealth = 0;
  private ticking = false;
  readonly stats = { blobsStored: 0, blobsReused: 0, blobsDeleted: 0, reaped: 0, purged: 0, healthChecks: 0 };

  constructor(readonly o: BlobsExtensionOptions) {
    this.budget = new ByteBudget(o.inflightBytes ?? DEFAULT_INFLIGHT_BYTES);
  }

  private get now(): number {
    return this.srv.clock();
  }

  init(srv: DdnServer): void {
    this.srv = srv;
    this.db = srv.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS s_uploads (
        account_id TEXT NOT NULL, upload_id TEXT NOT NULL, state TEXT NOT NULL,
        device_id TEXT NOT NULL, created_at INTEGER NOT NULL, active_at INTEGER NOT NULL,
        final_at INTEGER, released_at INTEGER, guarded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, upload_id));
      CREATE INDEX IF NOT EXISTS s_uploads_state ON s_uploads(state, active_at);
      CREATE TABLE IF NOT EXISTS s_blobs (
        account_id TEXT NOT NULL, upload_id TEXT NOT NULL, idx TEXT NOT NULL, sha256 TEXT NOT NULL,
        size INTEGER NOT NULL, webhook_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER,
        PRIMARY KEY (account_id, upload_id, idx));
      CREATE INDEX IF NOT EXISTS s_blobs_att ON s_blobs(attachment_id);
    `);
    if (this.o.tickMs !== 0) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.o.log?.(`background: ${(e as Error).message}`)), this.o.tickMs ?? 30_000);
      this.timer.unref?.();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health(): Record<string, unknown> {
    const pool = this.o.hooks.list(POOL);
    return {
      serverBlobs: true,
      pool: { channels: new Set(pool.map((h) => h.channelId)).size, alive: pool.filter((h) => h.alive).length },
      discord: { cloudflareBlockedS: Math.round(this.o.sender.cloudflareBlockMs() / 1000) },
    };
  }

  // --- uploads

  /** Count log entries guarded by each upload (rule 8 leaseGuard is plaintext): 2+ = committed/aborted in the log. */
  onAppend(acct: string, entry: { leaseGuard?: string[] }): void {
    for (const u of entry.leaseGuard ?? []) {
      this.db
        .prepare(
          `INSERT INTO s_uploads (account_id, upload_id, state, device_id, created_at, active_at, guarded) VALUES (?, ?, 'open', '', ?, ?, 1)
           ON CONFLICT(account_id, upload_id) DO UPDATE SET guarded = guarded + 1, active_at = excluded.active_at,
             state = CASE WHEN guarded + 1 >= 2 AND state IN ('open', 'final') THEN 'committed' ELSE state END`,
        )
        .run(acct, u, this.now, this.now);
    }
  }

  private upload(acct: string, u: string): { state: UploadState; device_id: string; active_at: number; final_at: number | null; released_at: number | null } | undefined {
    return this.db.prepare("SELECT state, device_id, active_at, final_at, released_at FROM s_uploads WHERE account_id = ? AND upload_id = ?").get(acct, u) as never;
  }

  /** Rule 8 + tombstones: a reaped/aborted upload never gets a lease again. */
  leaseGate(acct: string, u: string, device: string): boolean {
    const up = this.upload(acct, u);
    if (!up) return true;
    if (up.state === "aborted" || up.state === "reaped" || up.state === "purged") return false;
    this.db.prepare("UPDATE s_uploads SET active_at = ? WHERE account_id = ? AND upload_id = ?").run(this.now, acct, u);
    void device;
    return true;
  }

  private requireLease(acct: string, dev: string, u: string): void {
    if (!this.srv.holdsLease(acct, u, dev)) throw new HttpError(409, "lease_required");
  }

  private async putBlob(r: ExtRequest, u: string, idx: string): Promise<void> {
    const s = r.session();
    if (!isClientId(u)) throw new HttpError(400, "bad_upload_id");
    if (!/^(m|\d{1,6})$/.test(idx)) throw new HttpError(400, "bad_index");
    const sha = String(r.req.headers["x-ddn-sha256"] ?? "").toLowerCase();
    if (!HEX64.test(sha)) throw new HttpError(400, "bad_sha256");
    const len = Number(r.req.headers["content-length"] ?? NaN);
    if (!Number.isInteger(len)) throw new HttpError(411, "length_required");
    if (len > MAX_BLOB_BYTES) throw new HttpError(413, "body_too_large");
    this.requireLease(s.accountId, s.deviceId, u);
    const up = this.upload(s.accountId, u);
    if (up && up.state !== "open" && up.state !== "final") throw new HttpError(up.state === "committed" ? 409 : 410, up.state === "committed" ? "upload_committed" : "upload_gone");
    if (!up)
      this.db.prepare("INSERT INTO s_uploads (account_id, upload_id, state, device_id, created_at, active_at) VALUES (?, ?, 'open', ?, ?, ?)").run(s.accountId, u, s.deviceId, this.now, this.now);
    else this.db.prepare("UPDATE s_uploads SET active_at = ? WHERE account_id = ? AND upload_id = ?").run(this.now, s.accountId, u);

    const old = this.db.prepare("SELECT * FROM s_blobs WHERE account_id = ? AND upload_id = ? AND idx = ? AND deleted_at IS NULL").get(s.accountId, u, idx) as BlobRow | undefined;
    if (old && old.sha256 === sha) {
      // Resume: already on Discord. Drain the body (not stored) and answer with the placement.
      for await (const _ of r.req) void _;
      this.stats.blobsReused++;
      return r.send(200, { placement: placementOfRow(old), reused: true });
    }

    const release = await this.budget.acquire(len);
    const ac = new AbortController();
    const onClose = () => {
      if (!r.res.writableFinished) ac.abort(new Error("client went away"));
    };
    r.res.on("close", onClose);
    try {
      const buf = Buffer.allocUnsafe(len);
      let o = 0;
      for await (const c of r.req) {
        const b = c as Buffer;
        if (o + b.length > len) throw new HttpError(413, "body_too_large");
        b.copy(buf, o);
        o += b.length;
      }
      if (o !== len) throw new HttpError(400, "short_body");
      if (createHash("sha256").update(buf).digest("hex") !== sha) throw new HttpError(400, "sha256_mismatch");
      const hooks = this.o.hooks.hooksFor(s.accountId);
      const filename = `${randomBytes(16).toString("base64url")}${BLOB_EXT}`;
      let p: DiscordPlacement & { url: string };
      try {
        p = await this.o.sender.post(hooks, buf, filename, ac.signal);
      } catch (e) {
        throw senderHttpError(e);
      }
      for (const h of hooks) if (h.alive === false) this.o.hooks.setAlive(h.id, false);
      // Re-check: cancelled or reaped while posting -> do not keep it.
      const now = this.upload(s.accountId, u);
      if (!now || (now.state !== "open" && now.state !== "final")) {
        await this.deleteMessage(p.locationId, p.messageId).catch(() => {});
        throw new HttpError(410, "upload_gone");
      }
      if (old) await this.deleteMessage(old.webhook_id, old.message_id).catch(() => {});
      this.db
        .prepare(
          `INSERT INTO s_blobs (account_id, upload_id, idx, sha256, size, webhook_id, channel_id, message_id, attachment_id, filename, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, upload_id, idx) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, webhook_id = excluded.webhook_id,
             channel_id = excluded.channel_id, message_id = excluded.message_id, attachment_id = excluded.attachment_id, filename = excluded.filename,
             created_at = excluded.created_at, deleted_at = NULL`,
        )
        .run(s.accountId, u, idx, sha, len, p.locationId, p.channelId, p.messageId, p.attachmentId, filename, this.now);
      this.links.set(p.attachmentId, { url: p.url, until: this.now + 3600_000 });
      this.stats.blobsStored++;
      r.send(200, { placement: { provider: "discord-webhook", locationId: p.locationId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId } });
    } finally {
      release();
      r.res.off("close", onClose);
    }
  }

  private finalize(r: ExtRequest, u: string): void {
    const s = r.session();
    this.requireLease(s.accountId, s.deviceId, u);
    const up = this.upload(s.accountId, u);
    if (!up) throw new HttpError(404, "no_such_upload");
    if (up.state !== "open" && up.state !== "final") throw new HttpError(410, "upload_gone");
    this.db.prepare("UPDATE s_uploads SET state = 'final', final_at = ?, active_at = ? WHERE account_id = ? AND upload_id = ?").run(this.now, this.now, s.accountId, u);
    r.send(200, { ok: true });
  }

  private async cancel(r: ExtRequest, u: string): Promise<void> {
    const s = r.session();
    const up = this.upload(s.accountId, u);
    if (!up) {
      // Nothing stored yet: still tombstone it, so a late blob cannot revive the upload.
      if (!isClientId(u)) throw new HttpError(400, "bad_upload_id");
      this.db.prepare("INSERT OR IGNORE INTO s_uploads (account_id, upload_id, state, device_id, created_at, active_at) VALUES (?, ?, 'aborted', ?, ?, ?)").run(s.accountId, u, s.deviceId, this.now, this.now);
      return r.send(200, { ok: true, deleted: 0 });
    }
    if (up.state === "final" || up.state === "committed" || up.state === "released") throw new HttpError(409, "upload_final");
    if (up.state === "open") {
      const lease = this.srv.leaseOf(s.accountId, u);
      if (lease && lease.deviceId !== s.deviceId && lease.expiresAt > this.now) throw new HttpError(409, "lease_held");
      this.db.prepare("UPDATE s_uploads SET state = 'aborted' WHERE account_id = ? AND upload_id = ?").run(s.accountId, u);
    }
    const deleted = await this.deleteBlobs(s.accountId, u);
    r.send(200, { ok: true, deleted });
  }

  private released(r: ExtRequest, body: unknown): void {
    const s = r.session();
    const list = (body as { uploads?: unknown })?.uploads;
    if (!Array.isArray(list) || list.length > 1000) throw new HttpError(400, "bad_uploads");
    let marked = 0;
    for (const x of list) {
      const o = x as { uploadId?: unknown; at?: unknown };
      if (!isClientId(o?.uploadId) || !Number.isFinite(o.at)) throw new HttpError(400, "bad_upload");
      const at = Math.min(Number(o.at), this.now);
      marked += Number(
        this.db
          .prepare("UPDATE s_uploads SET state = 'released', released_at = ? WHERE account_id = ? AND upload_id = ? AND state IN ('final', 'committed')")
          .run(at, s.accountId, o.uploadId as string).changes,
      );
    }
    r.send(200, { ok: true, marked });
  }

  // --- reading

  private ownBlob(acct: string, attachmentId: string): BlobRow {
    if (!/^\d{15,22}$/.test(attachmentId)) throw new HttpError(400, "bad_attachment");
    const b = this.db.prepare("SELECT * FROM s_blobs WHERE attachment_id = ? AND account_id = ? AND deleted_at IS NULL").get(attachmentId, acct) as BlobRow | undefined;
    if (!b) throw new HttpError(404, "no_such_blob");
    return b;
  }

  /** Fresh signed links for rows (bot refresh-urls in batches of 50, else GET through the webhook). */
  async freshUrls(rows: BlobRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const t = this.now;
    const need: BlobRow[] = [];
    for (const b of rows) {
      const c = this.links.get(b.attachment_id);
      if (c && c.until > t) out.set(b.attachment_id, c.url);
      else need.push(b);
    }
    if (need.length && this.o.bot) {
      for (let i = 0; i < need.length; i += 50) {
        const part = need.slice(i, i + 50);
        const fresh = await this.o.bot.refresh(part.map((b) => `${CDN}/${b.channel_id}/${b.attachment_id}/${b.filename}`));
        part.forEach((b, k) => this.remember(b.attachment_id, fresh[k]!, out));
      }
      return out;
    }
    for (const b of need) {
      const hook = this.o.hooks.hook(b.webhook_id);
      if (!hook) throw new HttpError(410, "webhook_removed");
      let atts;
      try {
        atts = await this.o.sender.attachments(hook, b.message_id);
      } catch (e) {
        throw senderHttpError(e);
      }
      const a = atts.find((x) => x.id === b.attachment_id);
      if (!a) throw new HttpError(404, "attachment_missing");
      this.remember(b.attachment_id, a.url, out);
    }
    return out;
  }

  private remember(att: string, url: string, out: Map<string, string>): void {
    if (!this.allowedCdn(url)) throw new HttpError(502, "bad_refreshed_url");
    const ex = parseInt(new URL(url).searchParams.get("ex") ?? "", 16);
    const left = Number.isFinite(ex) ? ex * 1000 - this.now - 3600_000 : 0;
    this.links.set(att, { url, until: this.now + Math.max(0, Math.min(12 * 3600_000, left)) });
    if (this.links.size > 50_000) for (const [k, v] of this.links) if (v.until <= this.now) this.links.delete(k);
    out.set(att, url);
  }

  private allowedCdn(u: string): boolean {
    try {
      const o = new URL(u).origin;
      return o === "https://cdn.discordapp.com" || o === "https://media.discordapp.net" || !!this.o.cdnOrigins?.includes(o);
    } catch {
      return false;
    }
  }

  /** BotRefresher for share links of this instance (works with or without a bot, §3.7). */
  shareRefresher(): BotRefresher {
    return {
      refresh: async (urls) => {
        const rows = urls.map((u) => {
          const m = /\/attachments\/\d+\/(\d+)\//.exec(new URL(u).pathname);
          const b = m ? (this.db.prepare("SELECT * FROM s_blobs WHERE attachment_id = ? AND deleted_at IS NULL").get(m[1]!) as BlobRow | undefined) : undefined;
          if (!b) throw new Error("refresh: unknown attachment");
          return b;
        });
        const fresh = await this.freshUrls(rows);
        return rows.map((b) => fresh.get(b.attachment_id)!);
      },
    };
  }

  /** The bytes of one blob (proxy path; plain mode reads through this too). */
  async readBlob(b: BlobRow, signal?: AbortSignal): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      const url = (await this.freshUrls([b])).get(b.attachment_id)!;
      try {
        return await this.o.sender.transport.fetchCdn(url, signal);
      } catch (e) {
        this.links.delete(b.attachment_id);
        if (attempt >= 2 || signal?.aborted) throw e;
      }
    }
  }

  /** Blob row by attachment ID within an account (plain: the server reads files it indexed). */
  blobByAttachment(acct: string, attachmentId: string): BlobRow | undefined {
    return this.db.prepare("SELECT * FROM s_blobs WHERE attachment_id = ? AND account_id = ? AND deleted_at IS NULL").get(attachmentId, acct) as BlobRow | undefined;
  }

  // --- channels of an account

  private channels(acct: string) {
    const pool = this.o.hooks.list(POOL);
    return {
      own: this.o.hooks.list(acct).map((h) => ({ id: h.id, channelId: h.channelId, label: h.label, alive: h.alive })),
      pool: { channels: new Set(pool.map((h) => h.channelId)).size, alive: pool.filter((h) => h.alive).length },
      using: this.o.hooks.list(acct).length ? "own" : pool.length ? "pool" : "none",
    };
  }

  // --- routing

  async route(r: ExtRequest): Promise<boolean> {
    const { method, path } = r;
    if (!path.startsWith("/v1/")) return false;
    const ub = /^\/v1\/uploads\/([A-Za-z0-9_-]{8,64})\/blobs\/(m|\d{1,6})$/.exec(path);
    if (ub && method === "PUT") return (await this.putBlob(r, ub[1]!, ub[2]!), true);
    if (method === "POST" && path === "/v1/uploads/released") return (this.released(r, await r.json()), true);
    // Cleanup state for Settings → Storage (the instance cleans in the background) and "Clean up now".
    if (method === "GET" && path === "/v1/gc") return (r.send(200, this.gcStatus(r.session().accountId)), true);
    if (method === "POST" && path === "/v1/gc/run") {
      const s = r.session();
      const res = await this.tick();
      return (r.send(200, { ...res, ...this.gcStatus(s.accountId) }), true);
    }
    const up = /^\/v1\/uploads\/([A-Za-z0-9_-]{8,64})(\/final)?$/.exec(path);
    if (up) {
      const s = r.session();
      if (up[2] && method === "POST") return (this.finalize(r, up[1]!), true);
      if (!up[2] && method === "DELETE") return (await this.cancel(r, up[1]!), true);
      if (!up[2] && method === "GET") {
        const st = this.upload(s.accountId, up[1]!);
        if (!st) throw new HttpError(404, "no_such_upload");
        const blobs = (this.db.prepare("SELECT idx, sha256 FROM s_blobs WHERE account_id = ? AND upload_id = ? AND deleted_at IS NULL").all(s.accountId, up[1]!) as { idx: string; sha256: string }[]);
        return (r.send(200, { state: st.state, blobs }), true);
      }
    }
    if (method === "POST" && path === "/v1/blobs/urls") {
      const s = r.session();
      const list = (await r.json() as { attachments?: unknown })?.attachments;
      if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, "bad_attachments");
      const rows = list.map((x) => this.ownBlob(s.accountId, String((x as { attachmentId?: unknown })?.attachmentId)));
      const fresh = await this.freshUrls(rows);
      return (r.send(200, { urls: rows.map((b) => ({ attachmentId: b.attachment_id, url: fresh.get(b.attachment_id) })) }), true);
    }
    if (method === "POST" && path === "/v1/blobs/describe") {
      const s = r.session();
      const ids = (await r.json() as { attachmentIds?: unknown })?.attachmentIds;
      if (!Array.isArray(ids) || ids.length > 5000) throw new HttpError(400, "bad_attachments");
      return (r.send(200, { attachments: ids.map((id) => {
        const b = this.ownBlob(s.accountId, String(id));
        return { channelId: b.channel_id, attachmentId: b.attachment_id, filename: b.filename };
      }) }), true);
    }
    const bl = /^\/v1\/blobs\/(\d{15,22})$/.exec(path);
    if (bl && method === "GET") {
      const s = r.session();
      const b = this.ownBlob(s.accountId, bl[1]!);
      const data = await this.readBlob(b);
      r.res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.byteLength, "cache-control": "private, max-age=3600" });
      r.res.end(data);
      return true;
    }
    if (path === "/v1/channels" || path.startsWith("/v1/channels/")) {
      const s = r.session();
      if (method === "GET" && path === "/v1/channels") return (r.send(200, this.channels(s.accountId)), true);
      if (method === "POST" && path === "/v1/channels") {
        const b = (await r.json()) as { url?: unknown; label?: unknown };
        if (typeof b?.url !== "string") throw new HttpError(400, "bad_url");
        try {
          await this.o.hooks.add(s.accountId, b.url, this.o.sender.transport, typeof b.label === "string" ? b.label : "");
        } catch (e) {
          const m = String((e as Error).message);
          if (/webhook_in_use|too_many_channels/.test(m)) throw new HttpError(409, m.match(/webhook_in_use|too_many_channels/)![0]);
          throw new HttpError(400, "bad_webhook");
        }
        return (r.send(201, this.channels(s.accountId)), true);
      }
      const one = /^\/v1\/channels\/(\d{15,22})$/.exec(path);
      if (one && method === "DELETE") {
        if (!this.o.hooks.remove(s.accountId, one[1]!)) throw new HttpError(404, "no_such_channel");
        return (r.send(200, this.channels(s.accountId)), true);
      }
    }
    return false;
  }

  // --- deleting

  private async deleteMessage(webhookId: string, messageId: string): Promise<void> {
    const hook = this.o.hooks.hook(webhookId);
    if (!hook) throw new Error("webhook_removed");
    await this.o.sender.delete(hook, messageId);
  }

  /** Delete every stored blob of an upload from Discord; returns how many. Missing webhook = left for later. */
  async deleteBlobs(acct: string, u: string): Promise<number> {
    const rows = this.db.prepare("SELECT * FROM s_blobs WHERE account_id = ? AND upload_id = ? AND deleted_at IS NULL").all(acct, u) as unknown as BlobRow[];
    let n = 0;
    for (const b of rows) {
      try {
        await this.deleteMessage(b.webhook_id, b.message_id);
      } catch (e) {
        if (e instanceof DiscordUnavailableError) throw e;
        continue;
      }
      this.db.prepare("UPDATE s_blobs SET deleted_at = ? WHERE account_id = ? AND upload_id = ? AND idx = ?").run(this.now, acct, u, b.idx);
      this.links.delete(b.attachment_id);
      n++;
      this.stats.blobsDeleted++;
    }
    return n;
  }

  /** What waits for the background cleanup of one account (Settings → Storage). */
  gcStatus(acct: string) {
    const ret = this.o.retentionMs ?? FRAGMENT_RETENTION_MS;
    const now = this.now;
    const w = this.db
      .prepare("SELECT count(*) AS n, min(released_at) AS first FROM s_uploads WHERE account_id = ? AND state = 'released'")
      .get(acct) as { n: number; first: number | null };
    const due = this.db.prepare("SELECT count(*) AS n FROM s_uploads WHERE account_id = ? AND state = 'released' AND released_at <= ?").get(acct, now - ret) as { n: number };
    const bytes = this.db
      .prepare("SELECT coalesce(sum(b.size), 0) AS b FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.account_id = ? AND u.state = 'released' AND b.deleted_at IS NULL")
      .get(acct) as { b: number };
    const done = this.db.prepare("SELECT count(*) AS n FROM s_uploads WHERE account_id = ? AND state = 'purged'").get(acct) as { n: number };
    const last = this.db.prepare("SELECT v FROM server_meta WHERE k = 'gc_last_tick'").get() as { v: string } | undefined;
    return {
      by: "server" as const,
      now,
      lastRunAt: last ? Number(last.v) : null,
      waiting: Number(w.n),
      waitingBytes: Number(bytes.b),
      due: Number(due.n),
      deletedUploads: Number(done.n),
      nextAt: w.first === null ? null : Number(w.first) + ret,
    };
  }

  /**
   * One background pass: abandoned uploads, released uploads past retention, aborted leftovers,
   * webhook health. Safe to run any time; tests call it with a driven clock.
   */
  async tick(): Promise<{ reaped: number; purged: number }> {
    if (this.ticking) return { reaped: 0, purged: 0 };
    this.ticking = true;
    try {
      const now = this.now;
      const idle = this.o.abandonAfterMs ?? 10 * 60_000;
      let reaped = 0;
      let purged = 0;
      // Abandoned: open, or final whose commit never reached the log (guarded < 2), lease expired.
      for (const u of this.db.prepare("SELECT account_id, upload_id FROM s_uploads WHERE state IN ('open', 'final') AND guarded < 2 AND active_at < ?").all(now - idle) as { account_id: string; upload_id: string }[]) {
        const lease = this.srv.leaseOf(u.account_id, u.upload_id);
        if (lease && lease.expiresAt > now) continue;
        // Tombstone first: from now on the lease of U is refused, so nothing can commit it.
        const t = this.db.prepare("UPDATE s_uploads SET state = 'reaped' WHERE account_id = ? AND upload_id = ? AND state IN ('open', 'final') AND guarded < 2").run(u.account_id, u.upload_id);
        if (t.changes === 0) continue;
        await this.deleteBlobs(u.account_id, u.upload_id);
        reaped++;
        this.stats.reaped++;
      }
      const ret = this.o.retentionMs ?? FRAGMENT_RETENTION_MS;
      for (const u of this.db.prepare("SELECT account_id, upload_id FROM s_uploads WHERE state = 'released' AND released_at <= ?").all(now - ret) as { account_id: string; upload_id: string }[]) {
        await this.deleteBlobs(u.account_id, u.upload_id);
        this.db.prepare("UPDATE s_uploads SET state = 'purged' WHERE account_id = ? AND upload_id = ?").run(u.account_id, u.upload_id);
        purged++;
        this.stats.purged++;
      }
      // Blobs of aborted/reaped uploads whose delete failed earlier (Discord was down).
      for (const u of this.db.prepare("SELECT DISTINCT b.account_id, b.upload_id FROM s_blobs b JOIN s_uploads u USING (account_id, upload_id) WHERE b.deleted_at IS NULL AND u.state IN ('aborted', 'reaped', 'purged') LIMIT 100").all() as { account_id: string; upload_id: string }[]) {
        await this.deleteBlobs(u.account_id, u.upload_id);
      }
      if (now - this.lastHealth >= HEALTH_EVERY_MS) {
        this.lastHealth = now;
        for (const h of this.o.hooks.all()) {
          const st = await this.o.sender.check(h);
          this.stats.healthChecks++;
          if (st !== "unknown") this.o.hooks.setAlive(h.id, st === "alive");
        }
      }
      this.db.prepare("INSERT INTO server_meta (k, v) VALUES ('gc_last_tick', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(now));
      return { reaped, purged };
    } finally {
      this.ticking = false;
    }
  }
}

export interface BlobRow {
  account_id: string;
  upload_id: string;
  idx: string;
  sha256: string;
  size: number;
  webhook_id: string;
  channel_id: string;
  message_id: string;
  attachment_id: string;
  filename: string;
  created_at: number;
  deleted_at: number | null;
}

function placementOfRow(b: BlobRow): DiscordPlacement {
  return { provider: "discord-webhook", locationId: b.webhook_id, channelId: b.channel_id, messageId: b.message_id, attachmentId: b.attachment_id };
}

function senderHttpError(e: unknown): Error {
  if (e instanceof HttpError) return e;
  if (e instanceof NoChannelError) return new HttpError(409, "need_channel");
  if (e instanceof DiscordUnavailableError) return new HttpError(503, e.cloudflare ? "discord_blocked" : "discord_busy", { "retry-after": String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) });
  if ((e as Error)?.name === "AbortError" || /aborted|went away/.test(String((e as Error)?.message))) return new HttpError(499, "client_closed");
  return new HttpError(502, "discord_failed");
}

export type { SenderHook };
