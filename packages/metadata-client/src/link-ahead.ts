// Fresh CDN links fetched AHEAD of the downloads that need them (metadata only: one GET of the message
// through its webhook per fragment). Measured on Discord: such a GET takes ~0.25–0.55 s, and before this
// every fragment waited for it inside its download slot, so a slot spent that time not downloading (owner's
// log: 13 % of slot time at 16 in flight, 21 % at 4). Now the links of the next fragments are fetched while
// the current ones download, so a slot only downloads.
//
// Limits (measured on a test server, GET /webhooks/<id>/<token>/messages/<id>): the bucket is per WEBHOOK
// (shared by all its messages; headers: limit 5, reset-after 1–2 s); evenly paced 2 GET/s per webhook gave
// no 429, 3/s a few `user`-scope 429s with retry_after 0.3 s. So each webhook starts at 2.5/s after a burst
// of 3 and creeps up (to 5/s) while there are no 429s; a 429 blocks that webhook for retry_after and lowers
// its rate (× 0.8). At most `maxActive` link requests are in flight in total. A 429 is not a failure.
//
// Signed links carry their expiry (`ex`, hex seconds); a link is reused until shortly before it, and a CDN
// 403/404 drops it (the caller fetches a new one once).

import { RateLimitedError } from "./discord-transport.js";
import { ChannelPacer } from "./rate-limit.js";
import type { DiscordPlacement } from "./types.js";

export interface LinkItem {
  p: DiscordPlacement;
  /** Transfer and fragment (logs only). */
  x?: string;
  i?: number | "m";
}

export interface LinkAheadOptions {
  /** Link requests in flight at once (all webhooks together). */
  maxActive?: number;
  /** Sustained link requests per webhook per minute (start; grows to maxPerMin without 429s). */
  perMin?: number;
  maxPerMin?: number;
  /** Requests a webhook may send back to back. */
  burst?: number;
  /** A link is used until this long before its expiry. */
  marginMs?: number;
  /** Links without an expiry are kept this long. */
  defaultTtlMs?: number;
  /** Cached links kept at most (oldest dropped). */
  maxCached?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How a link was obtained by the read that needed it. */
export type LinkHow = "hit" | "wait" | "miss";

interface Pending {
  promise: Promise<string>;
  resolve: (u: string) => void;
  reject: (e: unknown) => void;
  started: boolean;
  item: LinkItem;
}

/** Expiry (ms) of a signed Discord CDN link from its `ex` parameter (hex Unix seconds); null if none. */
export function linkExpiry(url: string): number | null {
  const m = /[?&]ex=([0-9a-fA-F]+)/.exec(url);
  if (!m) return null;
  const s = parseInt(m[1]!, 16);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

export class LinkAhead {
  readonly pacer: ChannelPacer;
  private readonly cache = new Map<string, { url: string; until: number }>();
  private readonly pending = new Map<string, Pending>();
  private queue: string[] = [];
  private active = 0;
  readonly o: Required<Omit<LinkAheadOptions, "now" | "sleep">>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Counters (diagnostics, tests): requests, reads that found the link ready / waited for one in flight / had to fetch it, 429s, links dropped after a CDN 403/404. */
  readonly stats = { req: 0, hit: 0, wait: 0, miss: 0, r429: 0, stale: 0, failed: 0, maxActive: 0 };
  /** Per webhook: link requests in flight (tests: limits). */
  readonly activeByHook = new Map<string, number>();

  constructor(
    /** One link request: the fresh URL of the placement's attachment. */
    private readonly fetchLink: (it: LinkItem, info: { queued: number; active: number; ahead: boolean }) => Promise<string>,
    o: LinkAheadOptions = {},
  ) {
    this.o = { maxActive: o.maxActive ?? 8, perMin: o.perMin ?? 150, maxPerMin: o.maxPerMin ?? Math.max(o.perMin ?? 150, 300), burst: o.burst ?? 3, marginMs: o.marginMs ?? 10 * 60_000, defaultTtlMs: o.defaultTtlMs ?? 10 * 60_000, maxCached: o.maxCached ?? 20_000 };
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pacer = new ChannelPacer({ perMin: this.o.perMin, maxPerMin: this.o.maxPerMin, minPerMin: 20, burst: this.o.burst, now: this.now, sleep: this.sleep });
  }

  /** A cached link still valid for a while, or null. */
  cached(p: DiscordPlacement): string | null {
    const c = this.cache.get(p.attachmentId);
    if (!c) return null;
    if (c.until > this.now()) return c.url;
    this.cache.delete(p.attachmentId);
    return null;
  }

  /** The CDN refused this link (403/404): forget it, the next need() fetches a new one. */
  drop(p: DiscordPlacement): void {
    if (this.cache.delete(p.attachmentId)) this.stats.stale++;
  }

  /** Fetch these links in the background, in this order (look-ahead of a download). Never throws. */
  want(items: LinkItem[]): void {
    for (const it of items) {
      const k = it.p.attachmentId;
      if (this.pending.has(k) || this.cached(it.p)) continue;
      this.add(it, false);
    }
    this.pump();
  }

  /** The link for a read that starts now: from the cache, from a request already on its way, or fetched first in line. */
  async need(it: LinkItem, signal?: AbortSignal): Promise<{ url: string; how: LinkHow }> {
    const hit = this.cached(it.p);
    if (hit) {
      this.stats.hit++;
      return { url: hit, how: "hit" };
    }
    let pd = this.pending.get(it.p.attachmentId);
    const how: LinkHow = pd ? "wait" : "miss";
    this.stats[how]++;
    if (!pd) pd = this.add(it, true);
    else if (!pd.started) {
      // queued but not sent yet: this read waits for it, so it goes first
      this.queue = [it.p.attachmentId, ...this.queue.filter((k) => k !== it.p.attachmentId)];
    }
    this.pump();
    const url = signal ? await abortable(pd.promise, signal) : await pd.promise;
    return { url, how };
  }

  private add(it: LinkItem, first: boolean): Pending {
    let resolve!: (u: string) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<string>((ok, bad) => ((resolve = ok), (reject = bad)));
    promise.catch(() => {}); // a look-ahead nobody waits for may fail quietly
    const pd: Pending = { promise, resolve, reject, started: false, item: it };
    this.pending.set(it.p.attachmentId, pd);
    if (first) this.queue.unshift(it.p.attachmentId);
    else this.queue.push(it.p.attachmentId);
    return pd;
  }

  private pump(): void {
    while (this.active < this.o.maxActive && this.queue.length) {
      const k = this.queue.shift()!;
      const pd = this.pending.get(k);
      if (!pd || pd.started) continue;
      pd.started = true;
      this.active++;
      this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
      void this.run(pd).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(pd: Pending): Promise<void> {
    const { p } = pd.item;
    const hook = p.locationId;
    for (;;) {
      await this.pacer.acquire(hook);
      this.activeByHook.set(hook, (this.activeByHook.get(hook) ?? 0) + 1);
      this.stats.req++;
      try {
        const url = await this.fetchLink(pd.item, { queued: this.queue.length, active: this.active, ahead: true });
        this.pacer.onSuccess(hook);
        const exp = linkExpiry(url);
        const t = this.now();
        this.cache.set(p.attachmentId, { url, until: exp ? Math.min(exp - this.o.marginMs, t + 6 * 3600_000) : t + this.o.defaultTtlMs });
        while (this.cache.size > this.o.maxCached) this.cache.delete(this.cache.keys().next().value!);
        this.pending.delete(p.attachmentId);
        pd.resolve(url);
        return;
      } catch (e) {
        if (e instanceof RateLimitedError && !e.cloudflare && e.retryAfterMs <= 60_000) {
          // the webhook's own bucket: wait it out on that webhook only, a bit slower from now on
          this.stats.r429++;
          this.pacer.onRateLimited(hook, e.retryAfterMs, "shared");
          continue;
        }
        this.stats.failed++;
        this.pending.delete(p.attachmentId);
        pd.reject(e);
        return;
      } finally {
        this.activeByHook.set(hook, (this.activeByHook.get(hook) ?? 1) - 1);
      }
    }
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise<T>((ok, bad) => {
    const on = () => bad(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", on, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", on), ok(v)),
      (e) => (signal.removeEventListener("abort", on), bad(e)),
    );
  });
}
