// Real Discord webhook transport (fetch; Node 22 and browsers).
//
// Rate limits measured on a test Discord server 2026-10-06:
//  - per-webhook bucket: x-ratelimit-limit 5, reset ~0.4 s per slot ("user" scope 429 when exceeded),
//  - per-CHANNEL shared limit ~30 messages/min after an initial burst ("shared" scope 429,
//    sent while x-ratelimit-remaining is still > 0, so headers alone cannot predict it).
// The transport only reports; pacing lives in ChannelPacer (rate-limit.ts).

import { NetworkError } from "./net.js";
import type { LaneFetch } from "./blob-store.js";
import type { ExtraFile, MessageAttachment, PostedAttachment, ReqTiming, WebhookRef, WebhookTransport } from "./types.js";
import { ms, nowMs } from "./transfer-log.js";

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

/**
 * multipart/form-data body of a webhook post. FormData with a Blob, NOT one Uint8Array: measured
 * 2026-10-14 in Chromium (10 MiB posts to a local server, 4 at once): a Uint8Array body goes at
 * ~8.5 MB/s, FormData/Blob at 180-400 MB/s (the renderer copies a typed-array body slowly; a Blob is
 * handed to the network service by reference).
 */
function webhookForm(filename: string, data: Uint8Array, extra: ExtraFile[] = []): FormData {
  const files = [{ filename, data }, ...extra];
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ content: "", attachments: files.map((f, i) => ({ id: i, filename: f.filename })) }));
  files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data as BlobPart], { type: "application/octet-stream" }), f.filename));
  return fd;
}

/** A message edit that keeps the attachments `keep` (by ID) and adds `extra`. */
function addFilesForm(keep: string[], extra: ExtraFile[]): FormData {
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ attachments: [...keep.map((id) => ({ id })), ...extra.map((f, i) => ({ id: i, filename: f.filename }))] }));
  extra.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data as BlobPart], { type: "application/octet-stream" }), f.filename));
  return fd;
}

/**
 * The same multipart body as webhookForm, as the parts to send one after another (Node: no copy of the
 * fragment; FormData + Blob + the request stream held three copies of every 10 MiB post in flight).
 */
export function webhookMultipart(filename: string, data: Uint8Array, extra: ExtraFile[] = []): { contentType: string; parts: Uint8Array[] } {
  const boundary = `----ddn${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const files = [{ filename, data }, ...extra];
  const part = (i: number, name: string) => `\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${name.replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const parts: Uint8Array[] = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify({ content: "", attachments: files.map((f, i) => ({ id: i, filename: f.filename })) })),
  ];
  files.forEach((f, i) => parts.push(enc.encode(part(i, f.filename)), f.data));
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, parts };
}

/** A fetch that can send a body given as parts without copying them (h2Fetch in the desktop agent). */
export type PartsFetch = typeof fetch & { sendParts?: (url: string, init: { method: string; headers: Record<string, string>; parts: Uint8Array[]; signal?: AbortSignal }) => Promise<Response> };

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

  /** A webhook post/edit with the fragment: as parts when the fetch can send them (no copy), else FormData. */
  private postReq(url: string, method: string, filename: string, data: Uint8Array, what: string, signal?: AbortSignal, timing?: ReqTiming, extra: ExtraFile[] = []): Promise<Response> {
    const pf = this.f as PartsFetch;
    if (pf.sendParts) {
      const mp = webhookMultipart(filename, data, extra);
      return this.req(url, { method }, what, signal, timing, (u, s) => pf.sendParts!(u, { method, headers: { "content-type": mp.contentType }, parts: mp.parts, signal: s }));
    }
    return this.req(url, { method, body: webhookForm(filename, data, extra) }, what, signal, timing);
  }

  async postFiles(hook: WebhookRef, data: Uint8Array, filename: string, extra: ExtraFile[], signal?: AbortSignal, timing?: ReqTiming): Promise<PostedAttachment & { extras: MessageAttachment[] }> {
    if (extra.length > 9) throw new Error("webhook post: at most 10 attachments");
    const res = await this.postReq(`${hook.url}?wait=true`, "POST", filename, data, "webhook post", signal, timing, extra);
    const j = (await res.json()) as { id: string; channel_id: string; attachments: { id: string; url: string; size: number; filename?: string }[] };
    const atts = j.attachments ?? [];
    // Discord answers the attachments in the order they were sent; matched by name to be sure (Discord drops
    // leading underscores from names: compared without them), else by position.
    const key = (n: string | undefined) => (n ?? "").replace(/^_+/, "");
    const first = atts.find((a) => key(a.filename) === key(filename)) ?? atts[0];
    if (!first) throw new Error("webhook post: no attachment in response");
    const rest = atts.filter((a) => a !== first);
    const extras = extra.map((f, i) => rest.find((a) => key(a.filename) === key(f.filename)) ?? (rest.length === extra.length ? rest[i] : undefined));
    // An extra the answer does not show is left out (previews are optional: the blob itself is stored).
    return { webhookId: hook.id, channelId: j.channel_id, messageId: j.id, attachmentId: first.id, sizeBytes: first.size, url: first.url, extras: extras.filter((a) => !!a).map((a) => ({ id: a!.id, url: a!.url, size: a!.size, filename: a!.filename })) };
  }

  async addFiles(hook: WebhookRef, messageId: string, keep: string[], extra: ExtraFile[]): Promise<MessageAttachment[]> {
    if (keep.length + extra.length > 10) throw new Error("webhook edit: at most 10 attachments");
    // Measured on Discord (2026-10-22): a PATCH listing the kept attachments by ID plus new files keeps the
    // old ones byte for byte under the same IDs.
    const res = await this.req(`${hook.url}/messages/${messageId}`, { method: "PATCH", body: addFilesForm(keep, extra) }, "webhook edit message");
    const j = (await res.json()) as { attachments: { id: string; url: string; size: number; filename?: string }[] };
    const atts = (j.attachments ?? []).map((a) => ({ id: a.id, url: a.url, size: a.size, filename: a.filename }));
    if (keep.some((id) => !atts.some((a) => a.id === id))) throw new Error("webhook edit: an attachment was dropped");
    return atts;
  }

  private async req(url: string, init: RequestInit, what: string, signal?: AbortSignal, timing?: ReqTiming, send?: (url: string, signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (this.apiOrigin) url = url.replace(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com/, this.apiOrigin);
    let res: Response;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const t0 = timing ? nowMs() : 0;
    try {
      const sig = signal ? AbortSignal.any([timeout, signal]) : timeout;
      res = await (send ? send(url, sig) : this.f(url, { ...init, signal: sig }));
      if (timing) {
        timing.ttfb = ms(t0);
        timing.st = res.status;
        // A Node transport with its own connections says which one answered (transfer log `ln`).
        const ln = res.headers.get("x-ddn-lane");
        if (ln !== null && timing.lane === undefined) timing.lane = Number(ln);
      }
    } catch (e) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      // No HTTP answer at all (offline, reset, DNS, timeout): the link, not Discord (net.ts tells them apart).
      throw new NetworkError(`${what}: ${timeout.aborted ? "timeout" : redactWebhookUrl(String((e as Error)?.message ?? e))}`, timeout.aborted);
    }
    if (res.status === 429) throw await rateLimitFrom(res);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new DiscordHttpError(res.status, what);
    }
    return res;
  }

  async postFile(hook: WebhookRef, data: Uint8Array, filename: string, signal?: AbortSignal, timing?: ReqTiming): Promise<PostedAttachment> {
    const res = await this.postReq(`${hook.url}?wait=true`, "POST", filename, data, "webhook post", signal, timing);
    const j = (await res.json()) as { id: string; channel_id: string; attachments: { id: string; url: string; size: number }[] };
    const a = j.attachments?.[0];
    if (!a) throw new Error("webhook post: no attachment in response");
    return { webhookId: hook.id, channelId: j.channel_id, messageId: j.id, attachmentId: a.id, sizeBytes: a.size, url: a.url };
  }

  async editMessageFile(hook: WebhookRef, messageId: string, data: Uint8Array, filename: string): Promise<PostedAttachment> {
    // attachments: [] of the new upload only => old attachment is dropped.
    const res = await this.postReq(`${hook.url}/messages/${messageId}`, "PATCH", filename, data, "webhook edit message");
    const j = (await res.json()) as { id: string; channel_id: string; attachments: { id: string; url: string; size: number }[] };
    const a = j.attachments?.[0];
    if (!a || j.attachments.length !== 1) throw new Error("webhook edit: unexpected attachments in response");
    return { webhookId: hook.id, channelId: j.channel_id, messageId: j.id, attachmentId: a.id, sizeBytes: a.size, url: a.url };
  }

  async getAttachments(hook: WebhookRef, messageId: string, timing?: ReqTiming): Promise<MessageAttachment[]> {
    const res = await this.req(`${hook.url}/messages/${messageId}`, { method: "GET" }, "webhook get message", undefined, timing);
    const j = (await res.json()) as { attachments: { id: string; url: string; size: number; filename?: string }[] };
    return (j.attachments ?? []).map((a) => ({ id: a.id, url: a.url, size: a.size, filename: a.filename }));
  }

  /** Extra connections for CDN reads (web: sandboxed iframes); lane 0 is this transport's own fetch. */
  private cdnLanes: LaneFetch[] = [];
  setCdnLanes(lanes: LaneFetch[]): void {
    this.cdnLanes = lanes;
  }

  async fetchCdn(url: string, signal?: AbortSignal, timing?: ReqTiming, lane = 0): Promise<Uint8Array> {
    const lf = lane > 0 ? this.cdnLanes[lane - 1] : undefined;
    const res = lf ? await this.laneReq(lf, url, signal, timing) : await this.req(url, { method: "GET" }, "cdn get", signal, timing);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      throw new NetworkError(`cdn get: body: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  /** A CDN GET on another connection; the lane reports its own time to first byte (x-ddn-ttfb). */
  private async laneReq(lf: LaneFetch, url: string, signal?: AbortSignal, timing?: ReqTiming): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await lf(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    } catch (e) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      throw new NetworkError(`cdn get (lane): ${timeout.aborted ? "timeout" : String((e as Error)?.message ?? e).slice(0, 80)}`, timeout.aborted);
    }
    if (timing) ((timing.ttfb = Number(res.headers.get("x-ddn-ttfb") ?? 0)), (timing.st = res.status));
    if (res.status === 429) throw await rateLimitFrom(res);
    if (!res.ok) throw new DiscordHttpError(res.status, "cdn get");
    return res;
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
