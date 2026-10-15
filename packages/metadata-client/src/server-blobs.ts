// Blobs through the instance (e2ee and plain modes, docs/stage3-modes.md §5).
//
// put:  PUT /v1/uploads/<U>/blobs/<i> with the ciphertext (one fragment, ≤ 10 MiB) and its
//       SHA-256; the server checks this device's lease on U, posts on Discord with the
//       instance webhooks and answers with the placement. The same (U, i, hash) again
//       returns the stored placement without posting twice (resume after a lost answer).
// get:  fresh CDN links from the server (POST /v1/blobs/urls, ≤ 50 at a time; the server
//       refreshes them with its bot or webhook), then straight from the CDN. Proxy fallback
//       (GET /v1/blobs/<attachmentId>) when the CDN is not reachable from the browser.
// finalize/abort: the server keeps a finalized upload, deletes an aborted one.
//
// No webhook URL ever reaches the client. Marker for the build-time mode check: ddn-server-blobs.

import { guardedRead, netCall, retryFree, watchedPost, NetworkError, type LaneTiming, type NetControl } from "./net.js";
import type { LaneFetch } from "./blob-store.js";
import { sha256Hex } from "./file-crypto.js";
import { AbortedError, type BlobGetContext, type BlobPutContext, type BlobStore } from "./blob-store.js";
import { errText, hostOf, ms, nowMs, type TransferLog } from "./transfer-log.js";
import type { HttpApi } from "./http-api.js";
import { ServerError } from "./http-api.js";
import type { DiscordPlacement } from "./types.js";

export const SERVER_BLOB_STORE_MARKER = "ddn-server-blobs";

/** Upload failed because the instance cannot reach Discord right now (Cloudflare, budget). */
export class InstanceBusyError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`instance_busy: retry in ${Math.round(retryAfterMs / 1000)} s`);
    this.name = "InstanceBusyError";
  }
}

export interface ServerBlobStoreOptions {
  /** Retries per blob on network errors / 5xx (busy answers wait their retry-after up to maxWaitMs). */
  maxRetries?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchCdn?: (url: string, signal?: AbortSignal, timing?: { ttfb?: number; st?: number }) => Promise<Uint8Array>;
}

export class ServerBlobStore implements BlobStore {
  readonly marker = SERVER_BLOB_STORE_MARKER;
  private readonly links = new Map<string, { url: string; until: number }>();
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchCdn: (url: string, signal?: AbortSignal, timing?: { ttfb?: number; st?: number }) => Promise<Uint8Array>;
  log: TransferLog | null = null;
  net: NetControl | null = null;
  /** Extra connections for CDN reads (web: sandboxed iframes, docs/evidence/2026-10-15-connections). */
  private cdnLanes: LaneFetch[] = [];
  setCdnLanes(lanes: LaneFetch[]): void {
    this.cdnLanes = lanes;
    if (this.net) this.net.laneCount = 1 + lanes.length;
  }
  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.net ? this.net.backoffMs(attempt) : 500 * 2 ** (attempt - 1));
  }
  /** CDN read on connection `lane` (0 = this page's fetch). */
  private async cdnOn(lane: number, url: string, signal: AbortSignal | undefined, timing: LaneTiming): Promise<Uint8Array> {
    const lf = lane > 0 ? this.cdnLanes[lane - 1] : undefined;
    if (!lf) return this.fetchCdn(url, signal, timing);
    const t0 = nowMs();
    let r: Response;
    try {
      r = await lf(url, { signal });
    } catch (e) {
      if (signal?.aborted) throw new AbortedError();
      throw new NetworkError(`cdn (lane): ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
    ((timing.ttfb = Number(r.headers.get("x-ddn-ttfb") ?? ms(t0))), (timing.st = r.status));
    if (!r.ok) throw new Error(`cdn: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  /** Channels the instance posts this account's blobs to (from GET /v1/channels; sizes the upload concurrency). */
  channels = 1;
  lanes(): number {
    return Math.max(1, this.channels);
  }
  /** CDN unreachable from here (CORS/network) -> read through the instance from now on. */
  proxyOnly = false;

  constructor(
    private readonly api: HttpApi,
    o: ServerBlobStoreOptions = {},
  ) {
    this.maxRetries = o.maxRetries ?? 4;
    this.maxWaitMs = o.maxWaitMs ?? 120_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchCdn =
      o.fetchCdn ??
      (async (url, signal, timing) => {
        const t0 = timing ? nowMs() : 0;
        const r = await fetch(url, { signal });
        if (timing) ((timing.ttfb = ms(t0)), (timing.st = r.status));
        if (!r.ok) throw new Error(`cdn: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
  }

  async put(data: Uint8Array, _filename: string, ctx: BlobPutContext = {}): Promise<DiscordPlacement> {
    const u = ctx.uploadId;
    const i = ctx.index ?? 0;
    if (!u) throw new Error("server blobs need an upload ID");
    const sha = ctx.sha256 ?? (await sha256Hex(data));
    let attempt = 0;
    let waited = 0;
    const log = this.log;
    for (let a = 0; ; a++) {
      if (ctx.signal?.aborted) throw new AbortedError();
      if (ctx.stats) ctx.stats.posts++;
      let r: Response;
      const t0 = log ? nowMs() : 0;
      const ev = log ? { dir: "up", x: u, i, a, k: "server", b: data.byteLength, fl: log.fl.up } : null;
      try {
        r = await netCall(this.net, "up", ctx.signal, () => watchedPost(this.net, data.byteLength, () => this.api.request("PUT", `/v1/uploads/${u}/blobs/${i}`, {
          // A Blob, not the Uint8Array: Chromium sends a typed-array body at ~8.5 MB/s, a Blob at hundreds
          // (measured 2026-10-14, discord-transport.ts webhookForm). Same bytes, same content-length.
          body: new Blob([data as BlobPart]),
          headers: { "content-type": "application/octet-stream", "x-ddn-sha256": sha },
          signal: ctx.signal,
        })));
      } catch (e) {
        if (log) log.emit("req", { ...ev, dur: ms(t0), err: errText(e) });
        if (ctx.signal?.aborted) throw new AbortedError();
        if (retryFree(e)) continue; // no network: waits at the gate
        if (++attempt > this.maxRetries) throw e;
        await this.backoff(attempt);
        continue;
      }
      if (r.ok) {
        const pl = ((await r.json()) as { placement: DiscordPlacement; reused?: boolean }).placement;
        // The server's own part (limiter, Discord request) is in its log (same x / i); here: the whole round trip.
        if (log) log.emit("req", { ...ev, dur: ms(t0), st: r.status, hook: pl.locationId, ch: pl.channelId });
        return pl;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string; retryAfterMs?: number };
      if (log) log.emit("req", { ...ev, dur: ms(t0), st: r.status, err: String(j.error ?? "?").slice(0, 80), ...(j.retryAfterMs ? { ra: j.retryAfterMs } : {}) });
      if (r.status === 503 || r.status === 429) {
        const wait = Math.max(500, Number(r.headers.get("retry-after") ?? 0) * 1000 || j.retryAfterMs || 2000);
        if (waited + wait > this.maxWaitMs) throw new InstanceBusyError(wait);
        waited += wait;
        await this.sleep(wait);
        continue;
      }
      if (r.status >= 500 && ++attempt <= this.maxRetries) {
        await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new ServerError(r.status, j.error ?? "?");
    }
  }

  async finalize(uploadId: string): Promise<void> {
    await this.api.json("POST", `/v1/uploads/${uploadId}/final`, {});
  }

  async abort(uploadId: string): Promise<void> {
    await this.api.json("DELETE", `/v1/uploads/${uploadId}`, undefined, [404]);
  }

  /** Fresh links for up to 50 placements in one call (download loop calls this every 50). */
  async prefetch(ps: DiscordPlacement[]): Promise<void> {
    if (this.proxyOnly) return;
    const t = Date.now();
    const need = ps.filter((p) => !((this.links.get(p.attachmentId)?.until ?? 0) > t));
    for (let k = 0; k < need.length; k += 50) {
      const part = need.slice(k, k + 50);
      const t0 = this.log ? nowMs() : 0;
      const r = await this.api.json<{ urls: { attachmentId: string; url: string }[] }>("POST", "/v1/blobs/urls", {
        attachments: part.map((p) => ({ webhookId: p.locationId, messageId: p.messageId, attachmentId: p.attachmentId })),
      });
      this.log?.emit("links", { dir: "down", n: part.length, dur: ms(t0), st: r.status });
      // Links live ~24 h; keep them 1 h, a refresh is cheap.
      for (const x of r.body.urls) this.links.set(x.attachmentId, { url: x.url, until: t + 3600_000 });
    }
    if (this.links.size > 20_000) for (const [k, v] of this.links) if (v.until <= t) this.links.delete(k);
  }

  async get(p: DiscordPlacement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    const log = ctx?.x !== undefined ? this.log : null;
    const ev = log ? { dir: "down", x: ctx!.x, i: ctx!.i ?? 0, hook: p.locationId, ch: p.channelId ?? null } : null;
    if (!this.proxyOnly) {
      // Fresh link from the instance; without network it waits at the gate like every other request.
      for (let a = 0; ; a++) {
        try {
          await netCall(this.net, "down", signal, () => this.prefetch([p]));
          break;
        } catch (e) {
          if (signal?.aborted) throw new AbortedError();
          if (retryFree(e)) continue;
          if (a >= this.maxRetries) throw e;
          await this.backoff(a + 1);
        }
      }
      const l = this.links.get(p.attachmentId);
      if (l) {
        const t0 = log ? nowMs() : 0;
        const timing: LaneTiming = {};
        try {
          const d = await netCall(this.net, "down", signal, () => guardedRead(this.net, timing, signal, (lane) => this.cdnOn(lane, l.url, signal, timing)));
          if (log) log.emit("req", { ...ev, k: "cdn", host: hostOf(l.url), b: d.byteLength, dur: ms(t0), ttfb: timing.ttfb, st: timing.st ?? 200, ...(timing.lane !== undefined ? { ln: timing.lane } : {}), fl: log.fl.down });
          return d;
        } catch (e) {
          if (log) log.emit("req", { ...ev, k: "cdn", host: hostOf(l.url), dur: ms(t0), ttfb: timing.ttfb, ...(timing.st ? { st: timing.st } : {}), ...(timing.lane !== undefined ? { ln: timing.lane } : {}), err: errText(e), fl: log.fl.down });
          if (signal?.aborted) throw new AbortedError();
          // No network: wait at the gate and try the CDN again (do not fall back to the instance for that).
          if (retryFree(e)) return this.get(p, signal, ctx);
          // A stale link or a CDN this browser cannot read (CORS): drop it and go through the instance.
          this.links.delete(p.attachmentId);
          // A CDN this browser cannot read (CORS, a TypeError like an offline fetch): through the instance from now on.
          if (e instanceof TypeError) this.proxyOnly = true;
        }
      }
    }
    return this.proxy(p, signal, ctx);
  }

  /** Read through the instance (it fetches from Discord): the fallback path. */
  async proxy(p: DiscordPlacement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    const log = ctx?.x !== undefined ? this.log : null;
    for (let attempt = 0; ; attempt++) {
      const t0 = log ? nowMs() : 0;
      let r: Response;
      try {
        r = await netCall(this.net, "down", signal, () => this.api.request("GET", `/v1/blobs/${p.attachmentId}?w=${p.locationId}&m=${p.messageId}`, { signal }));
      } catch (e) {
        if (log) log.emit("req", { dir: "down", x: ctx!.x, i: ctx!.i ?? 0, a: attempt, k: "proxy", hook: p.locationId, dur: ms(t0), err: errText(e), fl: log.fl.down });
        if (signal?.aborted) throw new AbortedError();
        if (retryFree(e)) {
          attempt--;
          continue;
        }
        if (attempt >= this.maxRetries) throw e;
        await this.backoff(attempt + 1);
        continue;
      }
      const ttfb = log ? ms(t0) : 0;
      if (r.ok) {
        const d = new Uint8Array(await r.arrayBuffer());
        if (log) log.emit("req", { dir: "down", x: ctx!.x, i: ctx!.i ?? 0, a: attempt, k: "proxy", hook: p.locationId, b: d.byteLength, dur: ms(t0), ttfb, st: r.status, fl: log.fl.down });
        return d;
      }
      if (log) log.emit("req", { dir: "down", x: ctx!.x, i: ctx!.i ?? 0, a: attempt, k: "proxy", hook: p.locationId, dur: ms(t0), st: r.status, fl: log.fl.down });
      if ((r.status >= 500 || r.status === 429) && attempt < this.maxRetries) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      throw new ServerError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "?");
    }
  }
}
