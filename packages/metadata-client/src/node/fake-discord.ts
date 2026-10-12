// Local fake of the Discord webhook + CDN surface over real HTTP (127.0.0.1),
// for tests of DiscordWebhookTransport and of the browser client without
// touching Discord. Mimics what koncept §7 measured: multipart POST ?wait=true,
// GET/PATCH/DELETE /messages/<id>, GET webhook, signed CDN links with ex/is/hm,
// permissive CORS (Discord reflects the origin; CDN sends *).
// Optional per-channel limit like the real one (§7): `perChannelPerMin`.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface Msg {
  webhookId: string;
  channelId: string;
  attachments: { id: string; filename: string; data: Uint8Array }[];
}

/** Extensions the real CDN serves with Access-Control-Allow-Origin (subset, measured 2026-10-09). */
export const CDN_CORS_EXT = new Set(["txt", "log", "json", "csv", "webm", "mp4", "png", "jpg", "gif", "webp"]);

export class FakeDiscord {
  /** Old behaviour (CORS for everything); off = like Discord today. */
  cdnCorsAll = false;
  private server: Server | null = null;
  readonly hooks = new Map<string, { token: string; channelId: string; name: string }>();
  readonly messages = new Map<string, Msg>();
  private readonly blobs = new Map<string, Uint8Array>();
  private next = 1_550_000_000_000_000_000n;
  origin = "";
  posts = 0;
  cdnGets = 0;
  /** Per-channel sustained limit (messages/min); 0 = off. */
  perChannelPerMin = 0;
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

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { message: "internal" })));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
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
      attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.data.byteLength, url: this.link(a.id) })),
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
      // Like the real CDN (measured 2026-10-09): CORS only for some types, by file extension.
      const ext = /\.([A-Za-z0-9]+)$/.exec(url.pathname)?.[1]?.toLowerCase() ?? "";
      const cors = this.cdnCorsAll || CDN_CORS_EXT.has(ext) ? { "access-control-allow-origin": "*" } : {};
      res.writeHead(200, { "content-type": "application/octet-stream", ...cors, "content-length": b.byteLength });
      return void res.end(b);
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

    const readForm = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = new Request(this.origin, { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) });
      return r.formData();
    };
    const fileOf = async (fd: FormData) => {
      const f = fd.get("files[0]");
      if (!(f instanceof Blob)) return null;
      return { filename: (f as File).name || "blob", data: new Uint8Array(await f.arrayBuffer()) };
    };

    if (!mid && req.method === "POST") {
      const wait = this.limited(hook.channelId);
      if (wait > 0) this.rejectedByChannel.set(hook.channelId, (this.rejectedByChannel.get(hook.channelId) ?? 0) + 1);
      if (wait > 0) return this.send(res, 429, { message: "The resource is being rate limited.", retry_after: wait, global: false }, { ...cors, "x-ratelimit-scope": "shared" });
      const f = await fileOf(await readForm());
      if (!f) return this.send(res, 400, { message: "no file" }, cors);
      if (f.data.byteLength > 20 * 1024 * 1024) return this.send(res, 413, { message: "Request entity too large" }, cors);
      const id = this.id();
      const aid = this.id();
      this.blobs.set(aid, f.data);
      this.attMeta.set(aid, { channelId: hook.channelId, filename: f.filename });
      const msg: Msg = { webhookId, channelId: hook.channelId, attachments: [{ id: aid, ...f }] };
      this.messages.set(id, msg);
      this.posts++;
      this.postsByChannel.set(hook.channelId, (this.postsByChannel.get(hook.channelId) ?? 0) + 1);
      return this.send(res, 200, this.msgJson(id, msg), cors);
    }
    const msg = mid ? this.messages.get(mid) : undefined;
    if (!msg || msg.webhookId !== webhookId) return this.send(res, 404, { message: "Unknown Message", code: 10008 }, cors);
    if (req.method === "GET") return this.send(res, 200, this.msgJson(mid!, msg), cors);
    if (req.method === "DELETE") {
      for (const a of msg.attachments) this.blobs.delete(a.id);
      this.messages.delete(mid!);
      res.writeHead(204, cors);
      return void res.end();
    }
    if (req.method === "PATCH") {
      const f = await fileOf(await readForm());
      if (!f) return this.send(res, 400, { message: "no file" }, cors);
      for (const a of msg.attachments) this.blobs.delete(a.id);
      const aid = this.id();
      this.blobs.set(aid, f.data);
      this.attMeta.set(aid, { channelId: msg.channelId, filename: f.filename });
      msg.attachments = [{ id: aid, ...f }];
      return this.send(res, 200, this.msgJson(mid!, msg), cors);
    }
    return this.send(res, 405, { message: "Method Not Allowed" }, cors);
  }
}
