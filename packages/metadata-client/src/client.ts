// Metadata-only client: DriveClient whose blobs go straight
// between the device and the user's webhooks (WebhookBlobStore); only the
// index operation goes through the arbiter. Works in Node and in the browser
// (fetch + WebCrypto). Marker for the build-time mode check: ddn-webhook-vault.

import type { ArbiterApi } from "./arbiter.js";
import { AbortedError, type BlobGetContext, type BlobPutContext, type BlobStore } from "./blob-store.js";
import { hostOf, ms, nowMs, reqErrFields, type TransferLog } from "./transfer-log.js";
import { RateLimitedError } from "./discord-transport.js";
import { guardedRead, netCall, retryFree, watchedPost, type LaneTiming, type NetControl } from "./net.js";
import type { LaneFetch } from "./blob-store.js";
import { DriveClient, type ResumeStore } from "./drive-client.js";
import { ChannelPacer } from "./rate-limit.js";
import { LinkAhead, type LinkAheadOptions, type LinkHow, type LinkItem } from "./link-ahead.js";
import type { InvalidOpAlert } from "./policies.js";
import type { DiscordPlacement, PostedAttachment, WebhookRef, WebhookTransport } from "./types.js";
import type { DeviceInfo, IndexStore } from "@ddv4/sync-core";

export {
  DEFAULT_CHUNK_SIZE,
  BLOB_EXT,
  MANIFEST_SCHEMA_VERSION,
  OpFailedError,
  decodeManifestRef,
  encodeManifestRef,
  memorySource,
  newId,
  type ByteSink,
  type ByteSource,
  type ManifestLocator,
  type UploadOptions,
  type UploadResult,
} from "./drive-client.js";

/** Build-time mode check (scripts grep bundles for it): webhook vault + direct posts. */
export const WEBHOOK_VAULT_MARKER = "ddn-webhook-vault";

export interface MetadataClientOptions {
  device: DeviceInfo;
  arbiter: ArbiterApi;
  transport: WebhookTransport;
  /** Webhooks from the user's vault. Fragments are spread over their channels. */
  webhooks: WebhookRef[];
  store?: IndexStore;
  pacer?: ChannelPacer;
  chunkSize?: number;
  /** Upload fragments in flight at once (the pacer still gates per channel); default from the channels. */
  concurrency?: number;
  /** Download fragments in flight at once (default: automatic). */
  downloadConcurrency?: number;
  /** Memory the pieces in flight may hold (bytes); bounds the automatic value. */
  memoryBudget?: number;
  /** Retries per fragment for non-429 errors. */
  maxRetries?: number;
  /** Renew the upload lease at least this often (ms). */
  leaseRenewMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Q10: called once per device that reached INVALID_OP_WARN_AFTER invalid ops. */
  onInvalidOps?: (a: InvalidOpAlert) => void;
  /** Network state (tests); default: a fresh one. */
  net?: NetControl;
  /** Unfinished transfers (resume after a reload). */
  resume?: ResumeStore;
  /** Links fetched ahead of downloads: limits (tests). */
  links?: LinkAheadOptions;
}

/** Blobs on the user's webhooks, paced per channel on this device. */
export class WebhookBlobStore implements BlobStore {
  readonly marker = WEBHOOK_VAULT_MARKER;
  readonly pacer: ChannelPacer;
  readonly hooks: Map<string, WebhookRef>;
  private rr = 0;
  log: TransferLog | null = null;
  net: NetControl | null = null;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly transport: WebhookTransport,
    webhooks: WebhookRef[],
    o: { pacer?: ChannelPacer; maxRetries?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; links?: LinkAheadOptions } = {},
  ) {
    if (webhooks.length === 0) throw new Error("no webhooks");
    this.hooks = new Map(webhooks.map((h) => [h.id, h]));
    this.pacer = o.pacer ?? new ChannelPacer({ now: o.now, sleep: o.sleep });
    this.maxRetries = o.maxRetries ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Its own pacer on real timers (a test's fake `sleep` with the real clock would spin); tests pass `links.now/sleep`.
    this.links = new LinkAhead((it, info) => this.fetchLink(it, info), o.links);
  }

  setCdnLanes(lanes: LaneFetch[]): void {
    (this.transport as { setCdnLanes?: (l: LaneFetch[]) => void }).setCdnLanes?.(lanes);
    if (this.net) this.net.laneCount = 1 + lanes.length;
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.net ? this.net.backoffMs(attempt) : 500 * 2 ** (attempt - 1));
  }

  /** Distinct channels of the active webhooks (a channel is the unit of Discord's limit). */
  lanes(): number {
    const act = [...this.hooks.values()].filter((h) => !h.retired);
    return Math.max(1, new Set(act.map((h) => h.channelId ?? `hook:${h.id}`)).size);
  }

  private readonly rrInChannel = new Map<string, number>();
  /**
   * Webhooks that take new pieces: not retired, not excluded by the caller (a move posts only to the
   * targets). The channel whose limiter frees up first (free channels evenly, not
   * blindly in turn: a channel slowed by a 429 is skipped while others have tokens); ties rotate, and
   * the webhooks of one channel take turns.
   */
  private nextHook(exclude?: ReadonlySet<string>): WebhookRef {
    const all = [...this.hooks.values()].filter((h) => !h.retired && !exclude?.has(h.id));
    if (!all.length) throw new Error("need_channel: no active channel to post to");
    const byChan = new Map<string, WebhookRef[]>();
    for (const h of all) {
      const k = h.channelId ?? `hook:${h.id}`;
      byChan.set(k, [...(byChan.get(k) ?? []), h]);
    }
    const chans = [...byChan.keys()];
    const off = this.rr++ % chans.length;
    let best = chans[off]!;
    let bestIn = Infinity;
    for (let k = 0; k < chans.length; k++) {
      const ch = chans[(off + k) % chans.length]!;
      const t = this.pacer.readyIn(ch);
      if (t < bestIn) ((best = ch), (bestIn = t));
    }
    const list = byChan.get(best)!;
    const j = this.rrInChannel.get(best) ?? 0;
    this.rrInChannel.set(best, j + 1);
    return list[j % list.length]!;
  }

  /** Post to one given webhook (snapshot objects go to the pointer's channel only). */
  async postTo(hookId: string, data: Uint8Array, filename: string): Promise<DiscordPlacement> {
    const hook = this.hook(hookId);
    return placementOf(await this.postOn(() => hook, data, filename, { posts: 0 }));
  }

  hook(id: string): WebhookRef {
    const h = this.hooks.get(id);
    if (!h) throw new Error(`webhook ${id} not in vault`);
    return h;
  }

  async put(data: Uint8Array, filename: string, ctx: BlobPutContext = {}): Promise<DiscordPlacement> {
    const tx = ctx.uploadId !== undefined ? { x: ctx.uploadId, i: ctx.index ?? 0 } : undefined;
    return placementOf(await this.postOn(() => this.nextHook(), data, filename, ctx.stats ?? { posts: 0 }, tx));
  }

  /** Post one blob with pacing per channel and retries (round-robin over the active webhooks, minus `exclude`). */
  async post(data: Uint8Array, filename: string, stats: { posts: number }, exclude?: ReadonlySet<string>): Promise<PostedAttachment> {
    return this.postOn(() => this.nextHook(exclude), data, filename, stats);
  }

  private async postOn(pick: () => WebhookRef, data: Uint8Array, filename: string, stats: { posts: number }, tx?: { x: string; i: number | "m" }): Promise<PostedAttachment> {
    let attempt = 0;
    const log = tx ? this.log : null;
    for (let a = 0; ; a++) {
      const hook = pick();
      const key = hook.channelId ?? `hook:${hook.id}`;
      const tq = log ? nowMs() : 0;
      await this.pacer.acquire(key);
      stats.posts++;
      const tr = log ? nowMs() : 0;
      const timing: { ttfb?: number; st?: number } = {};
      const ev = log ? { dir: "up", x: tx!.x, i: tx!.i, a, hook: hook.id, ch: hook.channelId ?? null, b: data.byteLength, lim: ms(tq, tr), lst: this.pacer.state(key), fl: log.fl.up } : null;
      try {
        const res = await netCall(this.net, "up", undefined, () => watchedPost(this.net, data.byteLength, () => this.transport.postFile(hook, data, filename, undefined, log ? timing : undefined)));
        if (!hook.channelId) hook.channelId = res.channelId;
        this.pacer.onSuccess(key);
        if (log) log.emit("req", { ...ev, ch: res.channelId, dur: ms(tr), ttfb: timing.ttfb, st: timing.st ?? 200 });
        return res;
      } catch (e) {
        if (log) log.emit("req", { ...ev, dur: ms(tr), ttfb: timing.ttfb, ...reqErrFields(e) });
        if (e instanceof RateLimitedError) {
          this.pacer.onRateLimited(key, e.retryAfterMs, e.scope);
          if (e.global && e.retryAfterMs > 60_000) throw e;
          continue; // 429s do not count against maxRetries: the pacer slows down instead
        }
        if (retryFree(e)) continue; // no network: it waits at the gate, the file does not fail
        if (++attempt > this.maxRetries) throw e;
        await this.backoff(attempt);
      }
    }
  }

  /**
   * Fresh CDN links, fetched ahead of the reads that need them (link-ahead.ts): the download hints the next
   * fragments (prefetch), so a download slot only waits for the CDN, not for the GET of the message.
   */
  readonly links: LinkAhead;

  /** One GET of the message through its webhook (the fresh signed link); logged as a `link` event. */
  private async fetchLink(it: LinkItem, info: { queued: number; active: number }): Promise<string> {
    const p = it.p;
    const hook = this.hook(p.locationId);
    const log = it.x !== undefined ? this.log : null;
    const timing: LaneTiming = {};
    const t0 = log ? nowMs() : 0;
    try {
      const atts = await netCall(this.net, "down", undefined, () => this.transport.getAttachments(hook, p.messageId, log ? timing : undefined));
      const a = atts.find((x) => x.id === p.attachmentId);
      if (!a) throw new Error("attachment missing from message");
      if (log) log.emit("link", { dir: "down", x: it.x, i: it.i ?? 0, hook: hook.id, ch: p.channelId ?? null, dur: ms(t0), ttfb: timing.ttfb, st: timing.st ?? 200, q: info.queued, act: info.active });
      return a.url;
    } catch (e) {
      if (log) log.emit("link", { dir: "down", x: it.x, i: it.i ?? 0, hook: hook.id, ch: p.channelId ?? null, dur: ms(t0), ttfb: timing.ttfb, ...reqErrFields(e), q: info.queued, act: info.active });
      throw e;
    }
  }

  /** Download hint: fetch the links of these placements in the background, in this order. */
  async prefetch(ps: DiscordPlacement[], ctx?: { x?: string; first?: number }): Promise<void> {
    this.links.want(ps.map((p, k) => ({ p, x: ctx?.x, i: ctx?.first !== undefined ? ctx.first + k : undefined })));
  }

  /** Fetch a stored attachment: its link (ready from the look-ahead, or fetched now), then the CDN. */
  async get(p: DiscordPlacement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    const hook = this.hook(p.locationId);
    const log = ctx?.x !== undefined ? this.log : null;
    const ev = log ? { dir: "down", x: ctx!.x, i: ctx!.i ?? 0, hook: hook.id, ch: p.channelId ?? null } : null;
    let attempt = 0;
    let refreshed = false;
    for (let n = 0; ; n++) {
      let step = "link";
      let t0 = log ? nowMs() : 0;
      const timing: LaneTiming = {};
      let how: LinkHow | null = null;
      let lw = 0;
      try {
        const l = await this.links.need({ p, x: ctx?.x, i: ctx?.i }, signal);
        how = l.how;
        if (log) ((lw = ms(t0)), (t0 = nowMs()));
        step = "cdn";
        const data = await netCall(this.net, "down", signal, () => guardedRead(this.net, timing, signal, (lane) => this.transport.fetchCdn(l.url, signal, timing, lane)));
        // lk: where the link came from (hit = ready, wait = its request was on the way, miss = fetched now), lw: ms waited for it
        if (log) log.emit("req", { ...ev, a: n, k: "cdn", host: hostOf(l.url), b: data.byteLength, dur: ms(t0), ttfb: timing.ttfb, st: timing.st ?? 200, lk: how, lw, ...(timing.lane !== undefined ? { ln: timing.lane } : {}), fl: log.fl.down });
        return data;
      } catch (e) {
        if (log) log.emit("req", { ...ev, a: n, k: step, dur: ms(t0), ttfb: timing.ttfb, ...(how ? { lk: how, lw } : {}), ...(timing.lane !== undefined ? { ln: timing.lane } : {}), ...reqErrFields(e), fl: log.fl.down });
        if (signal?.aborted) throw new AbortedError();
        const st = (e as { status?: number }).status;
        if (step === "cdn" && (st === 403 || st === 404) && !refreshed) {
          // An expired or revoked link: one fresh link and again, not counted as a retry.
          this.links.drop(p);
          refreshed = true;
          continue;
        }
        if (e instanceof RateLimitedError) {
          await this.sleep(e.retryAfterMs);
          continue;
        }
        if (retryFree(e)) continue;
        // An HTTP error from the CDN may mean a bad link: the next try gets a fresh one. A network error
        // says nothing about the link (it stays; a new link request would only add traffic).
        if (step === "cdn" && st !== undefined) this.links.drop(p);
        if (++attempt > this.maxRetries) throw e;
        await this.backoff(attempt);
      }
    }
  }
}

export class MetadataClient extends DriveClient {
  readonly pacer: ChannelPacer;
  private readonly wh: WebhookBlobStore;

  constructor(o: MetadataClientOptions) {
    const wh = new WebhookBlobStore(o.transport, o.webhooks, { pacer: o.pacer, maxRetries: o.maxRetries, now: o.now, sleep: o.sleep, links: o.links });
    super({ ...o, blobs: wh });
    this.wh = wh;
    this.pacer = wh.pacer;
  }

  /** Post one blob (any kind: fragment, manifest, snapshot part) with per-channel pacing and retries. */
  async postBlob(data: Uint8Array, filename: string): Promise<DiscordPlacement> {
    return this.wh.put(data, filename);
  }

  /** Post one blob to the active webhooks except `exclude` (moving a channel's data away). */
  async postBlobExcept(data: Uint8Array, filename: string, exclude: ReadonlySet<string>): Promise<DiscordPlacement> {
    return placementOf(await this.wh.post(data, filename, { posts: 0 }, exclude));
  }

  /** Post one blob to one given webhook (snapshot objects: only on the pointer's channel). */
  async postBlobTo(hookId: string, data: Uint8Array, filename: string): Promise<DiscordPlacement> {
    return this.wh.postTo(hookId, data, filename);
  }

  get transport(): WebhookTransport {
    return this.wh.transport;
  }

  /** Webhook from the vault by ID (throws if unknown). */
  webhook(id: string): WebhookRef {
    return this.wh.hook(id);
  }

  /** The webhooks this client posts through. */
  get webhooks(): WebhookRef[] {
    return [...this.wh.hooks.values()];
  }

  setHookRetired(id: string, retired: boolean): void {
    const h = this.wh.hooks.get(id);
    if (h) h.retired = retired || undefined;
  }
}

export function placementOf(p: PostedAttachment): DiscordPlacement {
  return { provider: "discord-webhook", locationId: p.webhookId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId };
}
