// Local fake of the Discord webhook + CDN surface over real HTTP (127.0.0.1),
// for tests of DiscordWebhookTransport and of the browser client without
// touching Discord. Mimics what was measured: multipart POST ?wait=true,
// GET/PATCH/DELETE /messages/<id>, GET webhook, signed CDN links with ex/is/hm,
// permissive CORS (Discord reflects the origin; CDN sends *).
// Optional per-channel limit like the real one: `perChannelPerMin`.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createSecureServer } from "node:http2";

interface Msg {
  webhookId: string;
  channelId: string;
  attachments: { id: string; filename: string; data: Uint8Array; size?: number }[];
}

/** Extensions the real CDN serves with Access-Control-Allow-Origin (subset, measured 2026-10-09). */
export const CDN_CORS_EXT = new Set(["txt", "log", "json", "csv", "webm", "mp4", "png", "jpg", "gif", "webp"]);

export class FakeDiscord {
  /** Old behaviour (CORS for everything); off = like Discord today. */
  cdnCorsAll = false;
  private server: Server | ReturnType<typeof createSecureServer> | null = null;
  readonly hooks = new Map<string, { token: string; channelId: string; name: string }>();
  readonly messages = new Map<string, Msg>();
  /** Attachments in memory, or on disk under `blobDir` (big-file tests: GBs that must not sit in RAM). */
  blobDir: string | null = null;
  private readonly mem = new Map<string, Uint8Array>();
  private readonly blobs = {
    get: (id: string): Uint8Array | undefined => {
      if (!this.blobDir) return this.mem.get(id);
      const f = join(this.blobDir, id);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : undefined;
    },
    has: (id: string): boolean => (this.blobDir ? existsSync(join(this.blobDir, id)) : this.mem.has(id)),
    set: (id: string, d: Uint8Array): void => void (this.blobDir ? writeFileSync(join(this.blobDir, id), d) : this.mem.set(id, d)),
    delete: (id: string): void => void (this.blobDir ? rmSync(join(this.blobDir, id), { force: true }) : this.mem.delete(id)),
  };
  private next = 1_550_000_000_000_000_000n;
  origin = "";
  posts = 0;
  cdnGets = 0;
  /** Per-channel sustained limit (messages/min); 0 = off. */
  perChannelPerMin = 0;
  /** Benchmarks: extra time before a webhook post / a CDN read is answered (ms), like Discord's latency. */
  postDelayMs = 0;
  cdnDelayMs = 0;
  /** Extra time before a GET of a message (a fresh link) is answered (ms). */
  getDelayMs = 0;
  /**
   * Per-webhook limit on GET of messages like Discord's bucket (measured: 5 at once, ~1–2 s reset):
   * more than this many in any 1 s window answer 429 scope `user`. 0 = off.
   */
  getPerSecPerHook = 0;
  /** GETs of messages per webhook: [start, end] times (tests: rate and concurrency). */
  readonly getLog = new Map<string, { t0: number; t1: number; st: number }[]>();
  /**
   * CDN bandwidth (bytes/s) shared by every CDN body being sent, and the most one body gets on its own
   * (a CDN connection's own speed). 0 = unlimited. Tests: a narrow line with a known plateau.
   */
  cdnBytesPerSec = 0;
  cdnBytesPerSecPerRead = 0;
  private cdnSending = 0;
  /** Time (ms) up to which the shared CDN line is booked. */
  private cdnLineAt = 0;
  /** Origin headers of CDN reads (tests: a sandboxed lane sends "null"). */
  readonly cdnOriginsSeen = new Set<string>();
  /**
   * Cloudflare edge block of the webhook route until this time (ms): HTML 429, no
   * x-ratelimit-* headers, retry-after in seconds (ddrive 0d098ca). 0 = off.
   */
  cloudflareUntil = 0;
  /** Accepted posts per channel (tests: rotation over channels). */
  readonly postsByChannel = new Map<string, number>();
  /** 429 answers per channel. */
  readonly rejectedByChannel = new Map<string, number>();
  /** Every request that reached a webhook route (tests: egress budget). */
  webhookRequests = 0;
  /**
   * Tests: drop the connection of these webhook posts (1-based numbers of the posts, counted from the
   * moment this is set) after the body arrived: the client sees a network error ("Failed to fetch"),
   * nothing is stored. `dropPostEvery` = drop each post with this probability (0 = off).
   */
  dropPosts = new Set<number>();
  dropPostEvery = 0;
  private postNo = 0;
  postsDropped = 0;

  /** Delete a webhook (its URL answers 401/404 from now on, like a webhook removed in Discord). */
  deleteWebhook(id: string): void {
    this.hooks.delete(id);
  }

  /** Bytes of a stored attachment (tests: what landed on Discord). */
  attachmentData(attachmentId: string): Uint8Array | undefined {
    return this.blobs.get(attachmentId);
  }
  private readonly chanTimes = new Map<string, number[]>();

  private id(): string {
    this.next += BigInt(1 + Math.floor(Math.random() * 1000));
    return this.next.toString();
  }

  /** Create a webhook; returns a discord.com-shaped URL (the transport maps it to this origin). */
  addWebhook(channelId = this.id(), name = "fake"): { id: string; url: string; channelId: string } {
    const id = this.id();
    const token = randomBytes(34).toString("base64url");
    this.hooks.set(id, { token, channelId, name });
    return { id, url: `https://discord.com/api/webhooks/${id}/${token}`, channelId };
  }

  /**
   * Start on 127.0.0.1. `tls` (benchmarks): HTTPS with HTTP/2 like discord.com and its CDN (HTTP/1.1
   * still accepted), to measure a browser over one multiplexed connection instead of 6 per host.
   */
  async listen(o: { tls?: { key: string | Buffer; cert: string | Buffer } } = {}): Promise<string> {
    const h = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res).catch(() => this.send(res, 500, { message: "internal" }));
    this.server = o.tls ? createSecureServer({ ...o.tls, allowHTTP1: true, settings: { maxConcurrentStreams: 256, initialWindowSize: 16 << 20 } }, h as never) : createServer(h);
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.origin = `${o.tls ? "https" : "http"}://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...extra });
    res.end(data);
  }

  /** Discord-shaped CDN path: /attachments/<channel>/<attachment>/<filename>. */
  private link(aid: string): string {
    const ex = Math.floor(Date.now() / 1000 + 86400).toString(16);
    const meta = this.attMeta.get(aid);
    const path = meta ? `/attachments/${meta.channelId}/${aid}/${meta.filename}` : `/cdn/${aid}`;
    return `${this.origin}${path}?ex=${ex}&is=0&hm=${randomBytes(8).toString("hex")}`;
  }
  private readonly attMeta = new Map<string, { channelId: string; filename: string }>();
  /** Bot token accepted by POST /api/v10/attachments/refresh-urls (null = refresh off). */
  botToken: string | null = null;
  refreshCalls = 0;

  private msgJson(mid: string, m: Msg) {
    return {
      id: mid,
      channel_id: m.channelId,
      webhook_id: m.webhookId,
      attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size ?? a.data.byteLength, url: this.link(a.id) })),
    };
  }

  private limited(channelId: string): number {
    if (!this.perChannelPerMin) return 0;
    const now = Date.now();
    const t = (this.chanTimes.get(channelId) ?? []).filter((x) => x > now - 60_000);
    this.chanTimes.set(channelId, t);
    if (t.length >= this.perChannelPerMin) return (t[0]! + 60_000 - now) / 1000;
    t.push(now);
    return 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE",
        "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "content-type",
      });
      return void res.end();
    }
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/api/v10/attachments/refresh-urls" && req.method === "POST") {
      if (!this.botToken || req.headers.authorization !== `Bot ${this.botToken}`) return this.send(res, 401, { message: "401: Unauthorized", code: 0 });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { attachment_urls: string[] };
      this.refreshCalls++;
      const out = j.attachment_urls.map((u) => {
        const m = /\/attachments\/([^/]+)\/(\d+)\/([^/?]+)/.exec(new URL(u).pathname);
        return { original: u, refreshed: m && this.blobs.has(m[2]!) ? this.link(m[2]!) : u };
      });
      return this.send(res, 200, { refreshed_urls: out });
    }
    if (url.pathname === "/api/v10/users/@me" && req.method === "GET") {
      if (!this.botToken || req.headers.authorization !== `Bot ${this.botToken}`) return this.send(res, 401, { message: "401: Unauthorized", code: 0 });
      return this.send(res, 200, { id: "1550000000000000001", username: "fake-bot", bot: true });
    }
    const cdn = /^\/cdn\/(\d+)$/.exec(url.pathname) ?? /^\/attachments\/[^/]+\/(\d+)\/[^/]+$/.exec(url.pathname);
    if (cdn && req.method === "GET") {
      const b = this.blobs.get(cdn[1]!);
      if (!b || !url.searchParams.get("hm")) return this.send(res, 404, { message: "Not Found" });
      this.cdnGets++;
      this.cdnOriginsSeen.add(String(req.headers.origin ?? ""));
      if (this.cdnDelayMs) await new Promise((r) => setTimeout(r, this.cdnDelayMs));
      // Like the real CDN (measured 2026-10-09): CORS only for some types, by file extension.
      const ext = /\.([A-Za-z0-9]+)$/.exec(url.pathname)?.[1]?.toLowerCase() ?? "";
      const cors = this.cdnCorsAll || CDN_CORS_EXT.has(ext) ? { "access-control-allow-origin": "*" } : {};
      res.writeHead(200, { "content-type": "application/octet-stream", ...cors, "content-length": b.byteLength });
      if (!this.cdnBytesPerSec && !this.cdnBytesPerSecPerRead) return void res.end(b);
      // Paced body in 32 KiB steps on an absolute schedule (coarse timers, e.g. Windows' ~16 ms, do not add
      // up): this read at most its own speed, and all reads together at most the line (one shared schedule).
      this.cdnSending++;
      try {
        const t0 = Date.now();
        for (let o = 0; o < b.byteLength; ) {
          const n = Math.min(32 * 1024, b.byteLength - o);
          const own = this.cdnBytesPerSecPerRead ? t0 + ((o + n) / this.cdnBytesPerSecPerRead) * 1000 : 0;
          const line = this.cdnBytesPerSec ? (this.cdnLineAt = Math.max(this.cdnLineAt, Date.now()) + (n / this.cdnBytesPerSec) * 1000) : 0;
          const wait = Math.max(own, line) - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          if (!res.write(b.subarray(o, o + n))) await new Promise((r) => res.once("drain", r));
          o += n;
        }
      } finally {
        this.cdnSending--;
      }
      return void res.end();
    }
    const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([A-Za-z0-9_.-]+)(?:\/messages\/(\d+))?$/.exec(url.pathname);
    if (m) this.webhookRequests++;
    if (m && this.cloudflareUntil > Date.now()) {
      for await (const _ of req) void _;
      const ra = Math.ceil((this.cloudflareUntil - Date.now()) / 1000);
      res.writeHead(429, { "content-type": "text/html; charset=UTF-8", "retry-after": String(ra) });
      return void res.end("<!DOCTYPE html><title>Access denied | discord.com used Cloudflare to restrict access</title>");
    }
    const hook = m ? this.hooks.get(m[1]!) : undefined;
    if (!m || !hook || hook.token !== m[2]) return this.send(res, 401, { message: "Invalid Webhook Token", code: 50027 });
    const webhookId = m[1]!;
    const mid = m[3];
    const cors = { "access-control-allow-origin": req.headers.origin ?? "*" };

    if (!mid && req.method === "GET") return this.send(res, 200, { id: webhookId, channel_id: hook.channelId, guild_id: "fake-guild", name: hook.name }, cors);

    // files[0] of the multipart body, found by its part header and the closing boundary (cheap: a 10 MiB
    // post through Request.formData() cost the fake more CPU than the client it measures).
    const readFile = async (): Promise<{ filename: string; data: Uint8Array } | null> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const b = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(String(req.headers["content-type"] ?? ""));
      if (!b) return null;
      const boundary = Buffer.from(`--${b[1] ?? b[2]}`);
      const at = body.indexOf('name="files[0]"');
      if (at < 0) return null;
      const headEnd = body.indexOf("\r\n\r\n", at);
      const end = body.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), headEnd);
      if (headEnd < 0 || end < 0) return null;
      const filename = /filename="([^"]*)"/.exec(body.subarray(at, headEnd).toString("utf8"))?.[1] || "blob";
      return { filename, data: new Uint8Array(body.buffer, body.byteOffset + headEnd + 4, end - headEnd - 4) };
    };

    if (!mid && req.method === "POST") {
      const wait = this.limited(hook.channelId);
      if (wait > 0) this.rejectedByChannel.set(hook.channelId, (this.rejectedByChannel.get(hook.channelId) ?? 0) + 1);
      if (wait > 0) return this.send(res, 429, { message: "The resource is being rate limited.", retry_after: wait, global: false }, { ...cors, "x-ratelimit-scope": "shared" });
      const f = await readFile();
      if (this.postDelayMs) await new Promise((r) => setTimeout(r, this.postDelayMs));
      const no = ++this.postNo;
      if (this.dropPosts.has(no) || (this.dropPostEvery > 0 && Math.random() < this.dropPostEvery)) {
        this.postsDropped++;
        return void req.socket.destroy();
      }
      if (!f) return this.send(res, 400, { message: "no file" }, cors);
      if (f.data.byteLength > 20 * 1024 * 1024) return this.send(res, 413, { message: "Request entity too large" }, cors);
      const id = this.id();
      const aid = this.id();
      this.blobs.set(aid, f.data);
      this.attMeta.set(aid, { channelId: hook.channelId, filename: f.filename });
      // With blobDir the bytes live only on disk (a message keeps the ID and the name).
      const msg: Msg = { webhookId, channelId: hook.channelId, attachments: [{ id: aid, filename: f.filename, data: this.blobDir ? new Uint8Array(0) : f.data, size: f.data.byteLength }] };
      this.messages.set(id, msg);
      this.posts++;
      this.postsByChannel.set(hook.channelId, (this.postsByChannel.get(hook.channelId) ?? 0) + 1);
      return this.send(res, 200, this.msgJson(id, msg), cors);
    }
    const msg = mid ? this.messages.get(mid) : undefined;
    if (!msg || msg.webhookId !== webhookId) return this.send(res, 404, { message: "Unknown Message", code: 10008 }, cors);
    if (req.method === "GET") {
      const t0 = Date.now();
      const log = this.getLog.get(webhookId) ?? [];
      this.getLog.set(webhookId, log);
      if (this.getPerSecPerHook && log.filter((g) => g.st === 200 && g.t0 > t0 - 1000).length >= this.getPerSecPerHook) {
        log.push({ t0, t1: t0, st: 429 });
        return this.send(res, 429, { message: "You are being rate limited.", retry_after: 0.3, global: false }, { ...cors, "x-ratelimit-scope": "user" });
      }
      const g = { t0, t1: t0, st: 200 };
      log.push(g);
      if (this.getDelayMs) await new Promise((r) => setTimeout(r, this.getDelayMs));
      g.t1 = Date.now();
      return this.send(res, 200, this.msgJson(mid!, msg), cors);
    }
    if (req.method === "DELETE") {
      for (const a of msg.attachments) this.blobs.delete(a.id);
      this.messages.delete(mid!);
      res.writeHead(204, cors);
      return void res.end();
    }
    if (req.method === "PATCH") {
      const f = await readFile();
      if (!f) return this.send(res, 400, { message: "no file" }, cors);
      for (const a of msg.attachments) this.blobs.delete(a.id);
      const aid = this.id();
      this.blobs.set(aid, f.data);
      this.attMeta.set(aid, { channelId: msg.channelId, filename: f.filename });
      msg.attachments = [{ id: aid, filename: f.filename, data: this.blobDir ? new Uint8Array(0) : f.data, size: f.data.byteLength }];
      return this.send(res, 200, this.msgJson(mid!, msg), cors);
    }
    return this.send(res, 405, { message: "Method Not Allowed" }, cors);
  }
}
