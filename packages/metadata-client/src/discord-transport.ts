// Real Discord webhook transport (fetch; Node 22 and browsers).
//
// Rate limits measured on a test Discord server 2026-10-06 (koncept §7):
//  - per-webhook bucket: x-ratelimit-limit 5, reset ~0.4 s per slot ("user" scope 429 when exceeded),
//  - per-CHANNEL shared limit ~30 messages/min after an initial burst ("shared" scope 429,
//    sent while x-ratelimit-remaining is still > 0, so headers alone cannot predict it).
// The transport only reports; pacing lives in ChannelPacer (rate-limit.ts).

import type { MessageAttachment, PostedAttachment, WebhookRef, WebhookTransport } from "./types.js";

export class RateLimitedError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly scope: string | null,
    readonly global: boolean,
    /**
     * Cloudflare edge block of this IP on the webhook route (ddrive 0d098ca): 429 with an
     * HTML body and no x-ratelimit-* headers, retry-after in the thousands of seconds. Every
     * webhook reached from this IP fails until it lifts; waiting it out inside a request hangs it.
     */
    readonly cloudflare = false,
  ) {
    super(cloudflare ? `blocked by Cloudflare, retry in ${Math.round(retryAfterMs / 1000)} s` : `rate limited (${scope ?? "?"}), retry in ${retryAfterMs} ms`);
    this.name = "RateLimitedError";
  }
}

export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what}: HTTP ${status}`);
    this.name = "DiscordHttpError";
  }
}

/** Strip the token from anything that might end up in a log or error. */
export function redactWebhookUrl(s: string): string {
  return s.replace(/(\/webhooks\/\d+\/)[A-Za-z0-9_.-]+/g, "$1<redacted>");
}

/** Cloudflare edge block (HTML, no Discord rate-limit headers), not a Discord 429. */
export function isCloudflareBlock(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html") && res.headers.get("x-ratelimit-remaining") === null && res.headers.get("x-ratelimit-scope") === null;
}

async function rateLimitFrom(res: Response): Promise<RateLimitedError> {
  if (isCloudflareBlock(res)) {
    await res.body?.cancel().catch(() => {});
    const ra = Number(res.headers.get("retry-after") ?? 60);
    return new RateLimitedError(Math.ceil((Number.isFinite(ra) ? ra : 60) * 1000), null, true, true);
  }
  let body: { retry_after?: number; global?: boolean } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* Cloudflare HTML ban page: no JSON */
  }
  const ra = Number(body.retry_after ?? res.headers.get("retry-after") ?? 1);
  return new RateLimitedError(Math.ceil((Number.isFinite(ra) ? ra : 1) * 1000), res.headers.get("x-ratelimit-scope"), !!body.global);
}

export interface FetchTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Tests only: send requests for https://discord.com/api/... to this origin
   * instead (local fake, src/node/fake-discord.ts). Never set in production.
   */
  apiOrigin?: string;
}

export class DiscordWebhookTransport implements WebhookTransport {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiOrigin?: string;
  constructor(opts: FetchTransportOptions = {}) {
    this.apiOrigin = opts.apiOrigin;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async req(url: string, init: RequestInit, what: string, signal?: AbortSignal): Promise<Response> {
    if (this.apiOrigin) url = url.replace(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com/, this.apiOrigin);
    let res: Response;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      res = await this.f(url, { ...init, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    } catch (e) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      throw new Error(`${what}: ${redactWebhookUrl(String((e as Error)?.message ?? e))}`);
    }
    if (res.status === 429) throw await rateLimitFrom(res);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new DiscordHttpError(res.status, what);
    }
    return res;
  }

  async postFile(hook: WebhookRef, data: Uint8Array, filename: string, signal?: AbortSignal): Promise<PostedAttachment> {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: "", attachments: [{ id: 0, filename }] }));
    fd.append("files[0]", new Blob([data as BlobPart], { type: "application/octet-stream" }), filename);
    const res = await this.req(`${hook.url}?wait=true`, { method: "POST", body: fd }, "webhook post", signal);
    const j = (await res.json()) as { id: string; channel_id: string; attachments: { id: string; url: string; size: number }[] };
    const a = j.attachments?.[0];
    if (!a) throw new Error("webhook post: no attachment in response");
    return { webhookId: hook.id, channelId: j.channel_id, messageId: j.id, attachmentId: a.id, sizeBytes: a.size, url: a.url };
  }

  async editMessageFile(hook: WebhookRef, messageId: string, data: Uint8Array, filename: string): Promise<PostedAttachment> {
    const fd = new FormData();
    // attachments: [] of the new upload only => old attachment is dropped.
    fd.append("payload_json", JSON.stringify({ content: "", attachments: [{ id: 0, filename }] }));
    fd.append("files[0]", new Blob([data as BlobPart], { type: "application/octet-stream" }), filename);
    const res = await this.req(`${hook.url}/messages/${messageId}`, { method: "PATCH", body: fd }, "webhook edit message");
    const j = (await res.json()) as { id: string; channel_id: string; attachments: { id: string; url: string; size: number }[] };
    const a = j.attachments?.[0];
    if (!a || j.attachments.length !== 1) throw new Error("webhook edit: unexpected attachments in response");
    return { webhookId: hook.id, channelId: j.channel_id, messageId: j.id, attachmentId: a.id, sizeBytes: a.size, url: a.url };
  }

  async getAttachments(hook: WebhookRef, messageId: string): Promise<MessageAttachment[]> {
    const res = await this.req(`${hook.url}/messages/${messageId}`, { method: "GET" }, "webhook get message");
    const j = (await res.json()) as { attachments: { id: string; url: string; size: number }[] };
    return (j.attachments ?? []).map((a) => ({ id: a.id, url: a.url, size: a.size }));
  }

  async fetchCdn(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.req(url, { method: "GET" }, "cdn get", signal);
    return new Uint8Array(await res.arrayBuffer());
  }

  async inspectWebhook(hook: WebhookRef): Promise<{ id: string; channelId: string; guildId: string | null; name: string }> {
    const res = await this.req(hook.url, { method: "GET" }, "webhook get");
    const j = (await res.json()) as { id: string; channel_id: string; guild_id?: string | null; name?: string };
    if (j.id !== hook.id) throw new Error("webhook get: ID mismatch");
    return { id: j.id, channelId: j.channel_id, guildId: j.guild_id ?? null, name: j.name ?? "" };
  }

  async deleteMessage(hook: WebhookRef, messageId: string): Promise<void> {
    await this.req(`${hook.url}/messages/${messageId}`, { method: "DELETE" }, "webhook delete message");
  }
}

/** Parse a webhook URL into a WebhookRef (validates shape; never echoes the token). */
export function parseWebhookUrl(url: string): WebhookRef {
  const m = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,22})\/[A-Za-z0-9_.-]{20,}$/.exec(url.trim());
  if (!m) throw new Error("not a Discord webhook URL");
  return { id: m[1]!, url: url.trim() };
}
