// Server-side Discord sender for the e2ee and plain modes (docs/stage3-modes.md §4).
//
// Carried over (and cut down) from the production code, without Prisma/Redis:
//  - per-CHANNEL pacing (koncept §7, measured 2026-10-06: ~30 messages/min per channel,
//    shared by every webhook in it; 429 `shared` while x-ratelimit-remaining > 0, so pacing
//    must be proactive) -> ChannelPacer from @ddv4/metadata-client, one per process;
//  - rotation: each blob goes to the channel whose bucket frees up first (not blind
//    round-robin), webhooks inside a channel take turns;
//  - Cloudflare fail-fast (ddrive 0d098ca): an HTML 429 without x-ratelimit-* = this IP is
//    blocked on the webhook route for ~30-40 min. Remember it and fail every request at once
//    with a retry-after instead of sleeping inside the request (that hung shares for hours);
//  - proactive egress budget (discord-client c143f82): every request counts towards a
//    rolling 10-minute budget per IP; past half of it requests are slowed, at the ceiling they
//    are refused locally before Cloudflare would ban the IP;
//  - health checks: GET webhook; 401/404 = dead, skipped until a later check finds it alive.
//
// The webhook URLs live in the instance (encrypted at rest, see vault.ts) and never leave
// this process: errors are redacted.

import {
  ChannelPacer,
  DiscordHttpError,
  DiscordWebhookTransport,
  RateLimitedError,
  placementOf,
  redactWebhookUrl,
  type DiscordPlacement,
  type MessageAttachment,
  type WebhookRef,
  type WebhookTransport,
  type TransferLog,
} from "@ddv4/metadata-client";

/** Which transfer a post belongs to (server transfer logs). */
export interface SenderTx {
  log: TransferLog;
  x: string;
  i: number | "m";
}

const nowMs = () => Math.round(performance.timeOrigin * 10 + performance.now() * 10) / 10;
const since = (t: number) => Math.round((nowMs() - t) * 10) / 10;

/** Build-time mode check: the server posts blobs itself (never in a metadata-only bundle). */
export const SERVER_BLOBS_MARKER = "ddn-server-blobs";

export class DiscordUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly cloudflare: boolean,
  ) {
    super(message);
    this.name = "DiscordUnavailableError";
  }
}

export class NoChannelError extends Error {
  constructor() {
    super("need_channel");
    this.name = "NoChannelError";
  }
}

export interface SenderHook extends WebhookRef {
  channelId: string;
  /** false after a health check found it dead (401/404). */
  alive?: boolean;
}

export interface SenderOptions {
  transport?: WebhookTransport;
  pacer?: ChannelPacer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Retries per blob for non-429 errors. */
  maxRetries?: number;
  /** Proactive request budget per egress IP (requests per window). */
  egressBudget?: number;
  egressWindowMs?: number;
  /** Longest 429 wait done inside a request; longer = fail with a retry-after. */
  maxWaitMs?: number;
}

export class DiscordSender {
  readonly marker = SERVER_BLOBS_MARKER;
  readonly transport: WebhookTransport;
  readonly pacer: ChannelPacer;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly egressBudget: number;
  private readonly egressWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly rrInChannel = new Map<string, number>();
  private rrChannel = 0;
  private egress: number[] = [];
  /** Cloudflare block of this IP on the webhook route, until (ms). */
  blockedUntil = 0;
  readonly stats = { posts: 0, shared429: 0, other429: 0, cloudflare: 0, failed: 0, refusedBudget: 0 };

  constructor(o: SenderOptions = {}) {
    this.transport = o.transport ?? new DiscordWebhookTransport();
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pacer = o.pacer ?? new ChannelPacer({ now: this.now, sleep: this.sleep });
    this.maxRetries = o.maxRetries ?? 4;
    this.egressBudget = o.egressBudget ?? 6_000;
    this.egressWindowMs = o.egressWindowMs ?? 10 * 60_000;
    this.maxWaitMs = o.maxWaitMs ?? 60_000;
  }

  /** ms until the Cloudflare block lifts (0 = not blocked). */
  cloudflareBlockMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  private egressCount(): number {
    const cut = this.now() - this.egressWindowMs;
    if (this.egress.length && this.egress[0]! <= cut) this.egress = this.egress.filter((t) => t > cut);
    return this.egress.length;
  }

  /** Every outgoing request: refuse at the ceiling, slow down past half of the budget. */
  private async gateEgress(): Promise<void> {
    const cf = this.cloudflareBlockMs();
    if (cf > 0) throw new DiscordUnavailableError(`Discord is blocking this server's IP (Cloudflare); retry in ~${Math.round(cf / 1000)} s`, cf, true);
    const n = this.egressCount();
    if (n >= this.egressBudget) {
      this.stats.refusedBudget++;
      throw new DiscordUnavailableError("request budget of this server's IP used up; backing off before Cloudflare would", 5_000, false);
    }
    const half = this.egressBudget / 2;
    if (n >= half) await this.sleep(Math.round(150 + Math.min(1, (n - half) / half) * 1000));
    this.egress.push(this.now());
  }

  private noteRateLimit(key: string, e: RateLimitedError): void {
    if (e.cloudflare) {
      this.stats.cloudflare++;
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + e.retryAfterMs);
      return;
    }
    if (e.scope === "shared") this.stats.shared429++;
    else this.stats.other429++;
    this.pacer.onRateLimited(key, e.retryAfterMs, e.scope);
  }

  /** The channel whose bucket frees up first; webhooks of that channel take turns. */
  pick(hooks: SenderHook[]): SenderHook {
    const live = hooks.filter((h) => h.alive !== false);
    if (!live.length) throw new NoChannelError();
    const byChan = new Map<string, SenderHook[]>();
    for (const h of live) byChan.set(h.channelId, [...(byChan.get(h.channelId) ?? []), h]);
    let best: string | null = null;
    let bestIn = Infinity;
    // Ties (e.g. every bucket still has tokens) rotate, so a burst spreads over all channels.
    const chans = [...byChan.keys()].sort();
    const off = this.rrChannel++ % chans.length;
    for (let k = 0; k < chans.length; k++) {
      const ch = chans[(off + k) % chans.length]!;
      const t = this.pacer.readyIn(ch);
      if (t < bestIn) ((best = ch), (bestIn = t));
    }
    const list = byChan.get(best!)!;
    const i = this.rrInChannel.get(best!) ?? 0;
    this.rrInChannel.set(best!, i + 1);
    return list[i % list.length]!;
  }

  /** Post one blob through one of `hooks` (paced per channel, retried, fail-fast on Cloudflare). */
  async post(hooks: SenderHook[], data: Uint8Array, filename: string, signal?: AbortSignal, tx?: SenderTx): Promise<DiscordPlacement & { url: string }> {
    let attempt = 0;
    const log = tx?.log;
    for (let a = 0; ; a++) {
      signal?.throwIfAborted();
      const hook = this.pick(hooks);
      const tq = log ? nowMs() : 0;
      await this.pacer.acquire(hook.channelId);
      signal?.throwIfAborted();
      const te = log ? nowMs() : 0;
      await this.gateEgress();
      this.stats.posts++;
      const tr = log ? nowMs() : 0;
      const timing: { ttfb?: number; st?: number } = {};
      const ev = log ? { dir: "up", x: tx!.x, i: tx!.i, a, k: "discord", hook: hook.id, ch: hook.channelId, b: data.byteLength, lim: Math.round((te - tq) * 10) / 10, egress: Math.round((tr - te) * 10) / 10, lst: this.pacer.state(hook.channelId), fl: log.fl.up } : null;
      try {
        const r = await this.transport.postFile(hook, data, filename, signal, log ? timing : undefined);
        this.pacer.onSuccess(hook.channelId);
        if (log) log.emit("req", { ...ev, dur: since(tr), ttfb: timing.ttfb, st: timing.st ?? 200 });
        return { ...placementOf(r), url: r.url };
      } catch (e) {
        if (log) {
          const x = e as { status?: number; retryAfterMs?: number; scope?: string | null; global?: boolean; cloudflare?: boolean; message?: string };
          const rl = e instanceof RateLimitedError;
          log.emit("req", { ...ev, dur: since(tr), ttfb: timing.ttfb, ...(rl ? { st: 429, ra: x.retryAfterMs, scope: x.scope ?? null, glob: !!x.global, ...(x.cloudflare ? { cf: true } : {}), err: "429" } : { ...(typeof x.status === "number" ? { st: x.status } : {}), err: redactWebhookUrl(String(x.message ?? e)).replace(/\b[a-z]+:\/\/([^/\s]+)\S*/gi, "<url:$1>").slice(0, 200) }) });
        }
        if (signal?.aborted) throw e;
        if (e instanceof RateLimitedError) {
          this.noteRateLimit(hook.channelId, e);
          if (e.cloudflare || e.retryAfterMs > this.maxWaitMs) {
            throw new DiscordUnavailableError(e.cloudflare ? "Discord is blocking this server's IP (Cloudflare)" : "Discord rate limit too long to wait out", e.retryAfterMs, e.cloudflare);
          }
          continue; // 429 shared: the pacer slowed this channel; the next pick prefers another one
        }
        if (e instanceof DiscordHttpError && (e.status === 401 || e.status === 404)) {
          hook.alive = false; // deleted webhook: skip it, try the others
          continue;
        }
        this.stats.failed++;
        if (++attempt > this.maxRetries) throw new Error(redactWebhookUrl(String((e as Error)?.message ?? e)));
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  /** Fresh signed CDN links of a message sent by `hook` (GET through the webhook). */
  async attachments(hook: SenderHook, messageId: string): Promise<MessageAttachment[]> {
    let attempt = 0;
    for (;;) {
      await this.gateEgress();
      try {
        return await this.transport.getAttachments(hook, messageId);
      } catch (e) {
        if (e instanceof RateLimitedError) {
          this.noteRateLimit(`get:${hook.id}`, e);
          if (e.cloudflare || e.retryAfterMs > this.maxWaitMs) throw new DiscordUnavailableError("Discord unavailable", e.retryAfterMs, e.cloudflare);
          await this.sleep(e.retryAfterMs);
          continue;
        }
        if (e instanceof DiscordHttpError && e.status === 404) throw e;
        if (++attempt > this.maxRetries) throw new Error(redactWebhookUrl(String((e as Error)?.message ?? e)));
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  /** Delete a message (cleanup). Already gone (404) is fine. */
  async delete(hook: SenderHook, messageId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.gateEgress();
      try {
        return await this.transport.deleteMessage(hook, messageId);
      } catch (e) {
        if (e instanceof DiscordHttpError && e.status === 404) return;
        if (e instanceof RateLimitedError) {
          this.noteRateLimit(`del:${hook.id}`, e);
          if (e.cloudflare || e.retryAfterMs > this.maxWaitMs) throw new DiscordUnavailableError("Discord unavailable", e.retryAfterMs, e.cloudflare);
          await this.sleep(e.retryAfterMs);
          continue;
        }
        if (attempt >= this.maxRetries) throw new Error(redactWebhookUrl(String((e as Error)?.message ?? e)));
        await this.sleep(500 * 2 ** attempt);
      }
    }
  }

  /** Health check of one webhook: alive, dead (deleted/invalid) or unknown (network, Cloudflare). */
  async check(hook: SenderHook): Promise<"alive" | "dead" | "unknown"> {
    try {
      await this.gateEgress();
      const info = await this.transport.inspectWebhook(hook);
      hook.alive = true;
      hook.channelId = info.channelId;
      return "alive";
    } catch (e) {
      if (e instanceof DiscordHttpError && (e.status === 401 || e.status === 404)) {
        hook.alive = false;
        return "dead";
      }
      return "unknown";
    }
  }
}
