// Storage backends: where encrypted blobs (fragments, manifests, snapshot objects, the pointer) live.
//
// The client core (DriveClient, manifests, cleanup, moving a channel, snapshots) does not read the
// fields of a placement; it asks the registry for the backend of `placement.locationId` and lets that
// backend read, delete or overwrite. A backend kind is one provider:
//
//   discord-webhook  DiscordWebhookBackend: one user webhook (one channel). All webhooks of a client
//                    share one DiscordWebhooks: the transport, fresh CDN links fetched ahead of the
//                    reads (link-ahead.ts), retries and transfer-log events.
//   memory-bucket    MemoryBackend (memory-backend.ts): tests, proves a second kind works end to end.
//
// BackendBlobStore spreads new blobs over the writable backends (round-robin, the one whose limiter
// frees up first wins) and paces them per `paceKey` (Discord limits posts per channel).

import { AbortedError, type BlobGetContext, type BlobPutContext, type BlobStore, type ExtraPlacement, type LaneFetch } from "./blob-store.js";
import { DiscordHttpError, RateLimitedError } from "./discord-transport.js";
import { LinkAhead, type LinkAheadOptions, type LinkHow, type LinkItem } from "./link-ahead.js";
import { guardedRead, netCall, retryFree, watchedPost, type LaneTiming, type NetControl } from "./net.js";
import { ChannelPacer } from "./rate-limit.js";
import { hostOf, ms, nowMs, reqErrFields, type TransferLog } from "./transfer-log.js";
import { DISCORD_PROVIDER, isDiscordPlacement, type DiscordPlacement, type ExtraFile, type MessageAttachment, type Placement, type PostedAttachment, type ReqTiming, type WebhookRef, type WebhookTransport } from "./types.js";

/** One fixed, overwritable place on a backend (the snapshot pointer). Discord: a message edited in place. */
export interface BackendSlot {
  /** A new slot holding `data`; returns its name (Discord: the message ID). */
  create(data: Uint8Array, filename: string): Promise<string>;
  read(slot: string): Promise<Uint8Array>;
  /** Replace the content of the slot. */
  write(slot: string, data: Uint8Array, filename: string): Promise<void>;
  /** Delete the slot (a pointer that was moved). */
  remove?(slot: string): Promise<"deleted" | "gone">;
}

/** A read the store asks a backend to fetch ahead (transfer and fragment index: logs only). */
export interface PrefetchItem {
  p: Placement;
  x?: string;
  i?: number | "m";
}

export interface BlobBackend {
  /** Provider tag of the placements this backend writes ("discord-webhook", "memory-bucket", …). */
  readonly kind: string;
  /** Backend ID = `Placement.locationId` of everything it stores. */
  readonly id: string;
  /** Limiter key: the unit the provider limits (Discord: the channel). */
  readonly paceKey: string;
  /** Channel for transfer logs (Discord), null when unknown or not applicable. */
  readonly logChannel?: string | null;
  /** Retired: still read, gets no new blobs. */
  retired: boolean;
  /** Store one blob; `timing` is filled for transfer logs. Retries and pacing are the store's business. */
  put(data: Uint8Array, filename: string, signal?: AbortSignal, timing?: ReqTiming): Promise<Placement>;
  /** Store a blob with small extra blobs in one go (Discord: one message); absent = no extras on this backend. */
  putWithExtras?(data: Uint8Array, filename: string, extras: ExtraFile[], signal?: AbortSignal, timing?: ReqTiming): Promise<{ placement: Placement; extras: ExtraPlacement[] }>;
  /** The extras stored with `p`. */
  extrasOf?(p: Placement, signal?: AbortSignal): Promise<ExtraPlacement[]>;
  /** Add extras next to `p` (existing ones stay). */
  addExtras?(p: Placement, extras: ExtraFile[]): Promise<ExtraPlacement[]>;
  /** Read one blob, with the backend's own retries. */
  get(p: Placement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array>;
  /**
   * Who fetches reads ahead for this backend. Backends that share one (all Discord webhooks of a client
   * share one link queue) get one call with the items in download order.
   */
  readonly prefetcher?: { prefetch(items: PrefetchItem[]): void };
  /** Delete one blob. "gone" = it was not there any more; a blob that cannot be deleted is an error. */
  remove(p: Placement): Promise<"deleted" | "gone">;
  stat?(p: Placement): Promise<{ exists: boolean; size?: number }>;
  readonly slot: BackendSlot;
  /** Check the backend is reachable; its label and limiter key. */
  inspect(): Promise<{ label: string; paceKey: string }>;
  /** Extra connections for reads (web: sandboxed iframes). */
  setCdnLanes?(lanes: LaneFetch[]): void;
}

/** The backends of one account (from the vault): lookup by ID, the writable ones, the one for a placement. */
export class BackendRegistry {
  private readonly m = new Map<string, BlobBackend>();

  constructor(backends: Iterable<BlobBackend> = []) {
    for (const b of backends) this.add(b);
  }

  add(b: BlobBackend): void {
    this.m.set(b.id, b);
  }

  remove(id: string): void {
    this.m.delete(id);
  }

  has(id: string): boolean {
    return this.m.has(id);
  }

  byId(id: string): BlobBackend | undefined {
    return this.m.get(id);
  }

  all(): BlobBackend[] {
    return [...this.m.values()];
  }

  /** Backends that take new blobs. */
  writable(): BlobBackend[] {
    return this.all().filter((b) => !b.retired);
  }

  get size(): number {
    return this.m.size;
  }

  /** The backend that holds this placement (throws when it is not in the vault). */
  for(p: Placement): BlobBackend {
    const b = this.m.get(p.locationId);
    if (!b || b.kind !== p.provider) throw new Error(`${p.provider === DISCORD_PROVIDER ? "webhook" : "backend"} ${p.locationId} not in vault`);
    return b;
  }
}

/** Transfer-log and network state the store and its backends share (DriveClient sets both). */
export interface BlobRuntime {
  log: TransferLog | null;
  net: NetControl | null;
}

export interface BackendStoreOptions {
  pacer?: ChannelPacer;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Shared with the backends (DiscordWebhooks reads log/net from it). */
  rt?: BlobRuntime;
}

/** Blobs on the account's backends, paced per backend `paceKey` on this device. */
/** A post refused because the webhook no longer exists (deleted on Discord: 401 Unauthorized / 404). */
export function webhookGone(e: unknown): boolean {
  if (e instanceof DiscordHttpError) return e.status === 404 || e.status === 401;
  return /^webhook post: HTTP (401|404)\b/.test(String((e as Error)?.message ?? ""));
}

export class BackendBlobStore implements BlobStore {
  readonly pacer: ChannelPacer;
  readonly rt: BlobRuntime;
  /**
   * Backends whose posts answered 401 / 404 (a webhook removed on Discord): left out of new posts for the
   * rest of this session, the post goes on another one. The vault still lists them until the user removes
   * them (Settings shows the channel's files as unavailable).
   */
  readonly gone = new Set<string>();
  private rr = 0;
  private readonly rrInKey = new Map<string, number>();
  protected readonly maxRetries: number;
  protected readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly registry: BackendRegistry,
    o: BackendStoreOptions = {},
  ) {
    if (registry.size === 0) throw new Error("no webhooks");
    this.pacer = o.pacer ?? new ChannelPacer({ now: o.now, sleep: o.sleep });
    this.maxRetries = o.maxRetries ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rt = o.rt ?? { log: null, net: null };
  }

  get log(): TransferLog | null {
    return this.rt.log;
  }
  set log(l: TransferLog | null) {
    this.rt.log = l;
  }
  get net(): NetControl | null {
    return this.rt.net;
  }
  set net(n: NetControl | null) {
    this.rt.net = n;
  }

  setCdnLanes(lanes: LaneFetch[]): void {
    for (const b of this.registry.all()) b.setCdnLanes?.(lanes);
    if (this.net) this.net.laneCount = 1 + lanes.length;
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.net ? this.net.backoffMs(attempt) : 500 * 2 ** (attempt - 1));
  }

  /** Distinct limiter keys of the writable backends (a channel is the unit of Discord's limit). */
  lanes(): number {
    return Math.max(1, new Set(this.registry.writable().map((b) => b.paceKey)).size);
  }

  /**
   * Backend that takes the next blob: writable, not excluded by the caller (a move posts only to the
   * targets). The limiter key that frees up first wins (a channel slowed by a 429 is skipped while others
   * have tokens); ties rotate, and the backends of one key take turns.
   */
  private next(exclude?: ReadonlySet<string>): BlobBackend {
    const live = this.registry.writable().filter((b) => !exclude?.has(b.id));
    const all = live.filter((b) => !this.gone.has(b.id));
    if (!all.length && live.length) throw new Error("need_channel: every channel of the account answered 'unknown webhook' (removed on Discord): add a channel in Settings");
    if (!all.length) throw new Error("need_channel: no active channel to post to");
    const byKey = new Map<string, BlobBackend[]>();
    for (const b of all) byKey.set(b.paceKey, [...(byKey.get(b.paceKey) ?? []), b]);
    const keys = [...byKey.keys()];
    const off = this.rr++ % keys.length;
    let best = keys[off]!;
    let bestIn = Infinity;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[(off + k) % keys.length]!;
      const t = this.pacer.readyIn(key);
      if (t < bestIn) ((best = key), (bestIn = t));
    }
    const list = byKey.get(best)!;
    const j = this.rrInKey.get(best) ?? 0;
    this.rrInKey.set(best, j + 1);
    return list[j % list.length]!;
  }

  /** The backend with this ID (throws if unknown). */
  backend(id: string): BlobBackend {
    const b = this.registry.byId(id);
    if (!b) throw new Error(`backend ${id} not in vault`);
    return b;
  }

  /** Store on one given backend (snapshot objects go to the pointer's backend only). */
  async postTo(id: string, data: Uint8Array, filename: string): Promise<Placement> {
    const b = this.backend(id);
    const pick = () => b;
    this.pinned = pick;
    try {
      return await this.postOn(pick, data, filename, { posts: 0 });
    } finally {
      if (this.pinned === pick) this.pinned = null;
    }
  }

  async put(data: Uint8Array, filename: string, ctx: BlobPutContext = {}): Promise<Placement> {
    const tx = ctx.uploadId !== undefined ? { x: ctx.uploadId, i: typeof ctx.index === "string" && ctx.index !== "m" ? ("m" as const) : (ctx.index ?? 0) } : undefined;
    return this.postOn(() => this.next(), data, filename, ctx.stats ?? { posts: 0 }, tx);
  }

  /**
   * A blob with its extras in one post where the chosen backend can (Discord: one message), else the blob
   * alone (the extras are optional by contract). Paced and retried like put.
   */
  async putWithExtras(data: Uint8Array, filename: string, extras: ExtraFile[], ctx: BlobPutContext = {}): Promise<{ placement: Placement; extras: ExtraPlacement[] }> {
    const tx = ctx.uploadId !== undefined ? { x: ctx.uploadId, i: typeof ctx.index === "string" && ctx.index !== "m" ? ("m" as const) : (ctx.index ?? 0) } : undefined;
    let got: ExtraPlacement[] = [];
    const placement = await this.postOn(() => this.next(), data, filename, ctx.stats ?? { posts: 0 }, tx, (b, d, f, s, t) =>
      b.putWithExtras && extras.length ? b.putWithExtras(d, f, extras, s, t).then((r) => ((got = r.extras), r.placement)) : b.put(d, f, s, t),
    );
    return { placement, extras: got };
  }

  async extrasOf(p: Placement, signal?: AbortSignal): Promise<ExtraPlacement[]> {
    const b = this.registry.for(p);
    return b.extrasOf ? b.extrasOf(p, signal) : [];
  }

  async addExtras(p: Placement, extras: ExtraFile[]): Promise<ExtraPlacement[]> {
    const b = this.registry.for(p);
    if (!b.addExtras) throw new Error("this storage cannot keep previews");
    for (let attempt = 0; ; attempt++) {
      await this.pacer.acquire(b.paceKey);
      try {
        const r = await b.addExtras(p, extras);
        this.pacer.onSuccess(b.paceKey);
        return r;
      } catch (e) {
        if (e instanceof RateLimitedError) {
          this.pacer.onRateLimited(b.paceKey, e.retryAfterMs, e.scope);
          if (e.global && e.retryAfterMs > 60_000) throw e;
          continue;
        }
        if (attempt >= this.maxRetries) throw e;
        await this.backoff(attempt + 1);
      }
    }
  }

  /** post() with extras in the same message where the backend can (moving a manifest with its previews). */
  async postWithExtras(data: Uint8Array, filename: string, extras: ExtraFile[], exclude?: ReadonlySet<string>): Promise<Placement> {
    return this.postOn(() => this.next(exclude), data, filename, { posts: 0 }, undefined, (b, d, f, s, t) => (b.putWithExtras ? b.putWithExtras(d, f, extras, s, t).then((r) => r.placement) : b.put(d, f, s, t)));
  }

  /** Store one blob with pacing and retries (round-robin over the writable backends, minus `exclude`). */
  async post(data: Uint8Array, filename: string, stats: { posts: number }, exclude?: ReadonlySet<string>): Promise<Placement> {
    return this.postOn(() => this.next(exclude), data, filename, stats);
  }

  private async postOn(
    pick: () => BlobBackend,
    data: Uint8Array,
    filename: string,
    stats: { posts: number },
    tx?: { x: string; i: number | "m" },
    send: (b: BlobBackend, data: Uint8Array, filename: string, signal: AbortSignal | undefined, timing: ReqTiming | undefined) => Promise<Placement> = (b, d, f, s, t) => b.put(d, f, s, t),
  ): Promise<Placement> {
    let attempt = 0;
    const log = tx ? this.log : null;
    for (let a = 0; ; a++) {
      const b = pick();
      const key = b.paceKey;
      const tq = log ? nowMs() : 0;
      await this.pacer.acquire(key);
      stats.posts++;
      const tr = log ? nowMs() : 0;
      const timing: { ttfb?: number; st?: number; lane?: number } = {};
      const ev = log ? { dir: "up", x: tx!.x, i: tx!.i, a, hook: b.id, ch: b.logChannel ?? null, b: data.byteLength, lim: ms(tq, tr), lst: this.pacer.state(key), fl: log.fl.up } : null;
      try {
        const res = await netCall(this.net, "up", undefined, () => watchedPost(this.net, data.byteLength, () => send(b, data, filename, undefined, log ? timing : undefined)));
        this.pacer.onSuccess(key);
        if (log) log.emit("req", { ...ev, ch: (res as { channelId?: string }).channelId ?? b.logChannel ?? null, dur: ms(tr), ttfb: timing.ttfb, st: timing.st ?? 200, ...(timing.lane !== undefined ? { ln: timing.lane } : {}) });
        return res;
      } catch (e) {
        if (log) log.emit("req", { ...ev, dur: ms(tr), ttfb: timing.ttfb, ...(timing.lane !== undefined ? { ln: timing.lane } : {}), ...reqErrFields(e) });
        if (e instanceof RateLimitedError) {
          this.pacer.onRateLimited(key, e.retryAfterMs, e.scope);
          if (e.global && e.retryAfterMs > 60_000) throw e;
          continue; // 429s do not count against maxRetries: the pacer slows down instead
        }
        if (retryFree(e)) continue; // no network: it waits at the gate, the file does not fail
        // The webhook was removed on Discord: it is left out and this blob goes to another channel at once
        // (a 1 GB upload must not fail every few fragments on it). A backend given by the caller (postTo:
        // the pointer's channel) has no other: the error stands.
        if (webhookGone(e) && pick !== this.pinned) {
          this.gone.add(b.id);
          continue;
        }
        if (++attempt > this.maxRetries) throw e;
        await this.backoff(attempt);
      }
    }
  }
  /** Marker of postTo's fixed pick (a removed webhook there is an error, not a reason to go elsewhere). */
  private pinned: (() => BlobBackend) | null = null;

  /** Download hint: the backends fetch what these reads need ahead, in this order. */
  async prefetch(ps: Placement[], ctx?: { x?: string; first?: number }): Promise<void> {
    const groups = new Map<{ prefetch(items: PrefetchItem[]): void }, PrefetchItem[]>();
    ps.forEach((p, k) => {
      const pf = this.registry.byId(p.locationId)?.prefetcher;
      if (!pf) return;
      const l = groups.get(pf) ?? [];
      l.push({ p, x: ctx?.x, i: ctx?.first !== undefined ? ctx.first + k : undefined });
      groups.set(pf, l);
    });
    for (const [pf, items] of groups) pf.prefetch(items);
  }

  async get(p: Placement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    return this.registry.for(p).get(p, signal, ctx);
  }

  /** Delete one stored blob. */
  async remove(p: Placement): Promise<"deleted" | "gone"> {
    return this.registry.for(p).remove(p);
  }
}

// ── Discord ─────────────────────────────────────────────────────────

export function placementOf(p: PostedAttachment): DiscordPlacement {
  return { provider: DISCORD_PROVIDER, locationId: p.webhookId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId };
}

const isGone = (e: unknown) => /404|Unknown Message/.test(String((e as Error)?.message ?? e));

/** The pointer slot on a webhook: the message is edited in place (works through the webhook, also from a browser). */
export function discordSlot(transport: WebhookTransport, hook: WebhookRef): BackendSlot {
  return {
    create: async (data, filename) => (await transport.postFile(hook, data, filename)).messageId,
    read: async (messageId) => {
      const atts = await transport.getAttachments(hook, messageId);
      if (atts.length !== 1) throw new Error("pointer message: expected one attachment");
      return transport.fetchCdn(atts[0]!.url);
    },
    write: async (messageId, data, filename) => void (await transport.editMessageFile(hook, messageId, data, filename)),
    remove: async (messageId) => {
      try {
        await transport.deleteMessage(hook, messageId);
        return "deleted";
      } catch (e) {
        if (isGone(e)) return "gone";
        throw e;
      }
    },
  };
}

export interface DiscordWebhooksOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Links fetched ahead of downloads: limits (tests). */
  links?: LinkAheadOptions;
}

/**
 * What the Discord webhooks of one client share: the transport, the webhook refs (channel IDs are learned
 * from the first post), fresh CDN links fetched ahead of the reads, and the read path with its retries.
 */
export class DiscordWebhooks {
  readonly hooks = new Map<string, WebhookRef>();
  /**
   * Fresh CDN links, fetched ahead of the reads that need them (link-ahead.ts): the download hints the next
   * fragments (prefetch), so a download slot only waits for the CDN, not for the GET of the message.
   */
  readonly links: LinkAhead;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly transport: WebhookTransport,
    private readonly rt: BlobRuntime,
    o: DiscordWebhooksOptions = {},
  ) {
    this.maxRetries = o.maxRetries ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Its own pacer on real timers (a test's fake `sleep` with the real clock would spin); tests pass `links.now/sleep`.
    this.links = new LinkAhead((it, info) => this.fetchLink(it, info), o.links);
  }

  /** The backend of one webhook (the ref is kept and updated: its channel ID is learned from the first post). */
  backend(hook: WebhookRef): DiscordWebhookBackend {
    this.hooks.set(hook.id, hook);
    return new DiscordWebhookBackend(hook, this);
  }

  hook(id: string): WebhookRef {
    const h = this.hooks.get(id);
    if (!h) throw new Error(`webhook ${id} not in vault`);
    return h;
  }

  setCdnLanes(lanes: LaneFetch[]): void {
    (this.transport as { setCdnLanes?: (l: LaneFetch[]) => void }).setCdnLanes?.(lanes);
  }

  private backoff(attempt: number): Promise<void> {
    const net = this.rt.net;
    return this.sleep(net ? net.backoffMs(attempt) : 500 * 2 ** (attempt - 1));
  }

  /** Download hint: fetch the links of these placements in the background, in this order. */
  prefetch(items: PrefetchItem[]): void {
    this.links.want(items.filter((it) => isDiscordPlacement(it.p)).map((it) => ({ p: it.p as DiscordPlacement, x: it.x, i: it.i })));
  }

  /** One GET of the message through its webhook (the fresh signed link); logged as a `link` event. */
  private async fetchLink(it: LinkItem, info: { queued: number; active: number }): Promise<string> {
    const p = it.p;
    const hook = this.hook(p.locationId);
    const log = it.x !== undefined ? this.rt.log : null;
    const timing: LaneTiming = {};
    const t0 = log ? nowMs() : 0;
    try {
      const atts = await netCall(this.rt.net, "down", undefined, () => this.transport.getAttachments(hook, p.messageId, log ? timing : undefined));
      const a = atts.find((x) => x.id === p.attachmentId);
      if (!a) throw new Error("attachment missing from message");
      if (log) log.emit("link", { dir: "down", x: it.x, i: it.i ?? 0, hook: hook.id, ch: p.channelId ?? null, dur: ms(t0), ttfb: timing.ttfb, st: timing.st ?? 200, q: info.queued, act: info.active });
      return a.url;
    } catch (e) {
      if (log) log.emit("link", { dir: "down", x: it.x, i: it.i ?? 0, hook: hook.id, ch: p.channelId ?? null, dur: ms(t0), ttfb: timing.ttfb, ...reqErrFields(e), q: info.queued, act: info.active });
      throw e;
    }
  }

  /**
   * The attachments of a placement's message (one GET through the webhook, paced with the link look-ahead).
   * Their fresh links are cached, so reading an extra right after needs no second GET.
   */
  async messageAttachments(p: DiscordPlacement, fresh = false): Promise<MessageAttachment[]> {
    const k = `${p.locationId}:${p.messageId}`;
    const hit = fresh ? undefined : this.msgCache.get(k);
    if (hit && hit.until > Date.now()) return hit.atts;
    const hook = this.hook(p.locationId);
    for (let attempt = 0; ; attempt++) {
      // The same per-webhook pace as the link look-ahead (the same Discord bucket: GET of a message).
      await this.links.pacer.acquire(hook.id);
      try {
        const atts = await netCall(this.rt.net, "down", undefined, () => this.transport.getAttachments(hook, p.messageId));
        this.links.pacer.onSuccess(hook.id);
        this.rememberLinks(p, atts);
        return atts;
      } catch (e) {
        if (e instanceof RateLimitedError) {
          this.links.pacer.onRateLimited(hook.id, e.retryAfterMs, "shared");
          continue;
        }
        if (retryFree(e)) continue;
        if (attempt >= this.maxRetries) throw e;
        await this.backoff(attempt + 1);
      }
    }
  }
  private readonly msgCache = new Map<string, { atts: MessageAttachment[]; until: number }>();
  /** Keep the attachments of a message and their links (reads of its extras use them). */
  rememberLinks(p: DiscordPlacement, atts: MessageAttachment[]): void {
    const k = `${p.locationId}:${p.messageId}`;
    this.msgCache.delete(k);
    this.msgCache.set(k, { atts, until: Date.now() + 10 * 60_000 });
    while (this.msgCache.size > 2000) this.msgCache.delete(this.msgCache.keys().next().value!);
    for (const a of atts) this.links.put({ provider: DISCORD_PROVIDER, locationId: p.locationId, channelId: p.channelId, messageId: p.messageId, attachmentId: a.id }, a.url);
  }

  /** Fetch a stored attachment: its link (ready from the look-ahead, or fetched now), then the CDN. */
  async read(p: DiscordPlacement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    const hook = this.hook(p.locationId);
    const log = ctx?.x !== undefined ? this.rt.log : null;
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
        const data = await netCall(this.rt.net, "down", signal, () => guardedRead(this.rt.net, timing, signal, (lane) => this.transport.fetchCdn(l.url, signal, timing, lane)));
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
          // Spread out: every request waiting on this bucket would come back at the same instant.
          await this.sleep(e.retryAfterMs + Math.floor(Math.random() * 1500));
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

/** An extra attachment of the message `p` is in, as a placement of its own. */
function extraOf(p: DiscordPlacement, a: MessageAttachment): ExtraPlacement {
  const name = a.filename ?? "";
  const dot = name.lastIndexOf(".");
  return { name: dot > 0 ? name.slice(0, dot) : name, size: a.size, placement: { provider: DISCORD_PROVIDER, locationId: p.locationId, channelId: p.channelId, messageId: p.messageId, attachmentId: a.id } };
}

/** One user webhook as a storage backend: posts into its channel, reads through fresh CDN links. */
export class DiscordWebhookBackend implements BlobBackend {
  readonly kind = DISCORD_PROVIDER;
  readonly slot: BackendSlot;

  constructor(
    readonly hook: WebhookRef,
    private readonly dw: DiscordWebhooks,
  ) {
    this.slot = discordSlot(dw.transport, hook);
  }

  get id(): string {
    return this.hook.id;
  }
  /** The channel (Discord limits posts per channel); before the first post the webhook stands for it. */
  get paceKey(): string {
    return this.hook.channelId ?? `hook:${this.hook.id}`;
  }
  get logChannel(): string | null {
    return this.hook.channelId ?? null;
  }
  get retired(): boolean {
    return !!this.hook.retired;
  }
  set retired(r: boolean) {
    this.hook.retired = r || undefined;
  }
  get prefetcher(): DiscordWebhooks {
    return this.dw;
  }

  async put(data: Uint8Array, filename: string, signal?: AbortSignal, timing?: ReqTiming): Promise<DiscordPlacement> {
    const res = await this.dw.transport.postFile(this.hook, data, filename, signal, timing);
    if (!this.hook.channelId) this.hook.channelId = res.channelId;
    return placementOf(res);
  }

  /** One message: the blob first, the extras as its other attachments. */
  async putWithExtras(data: Uint8Array, filename: string, extras: ExtraFile[], signal?: AbortSignal, timing?: ReqTiming): Promise<{ placement: Placement; extras: ExtraPlacement[] }> {
    const t = this.dw.transport;
    if (!t.postFiles) return { placement: await this.put(data, filename, signal, timing), extras: [] };
    const res = await t.postFiles(this.hook, data, filename, extras, signal, timing);
    if (!this.hook.channelId) this.hook.channelId = res.channelId;
    const placement = placementOf(res);
    return { placement, extras: res.extras.map((a) => extraOf(placement, a)) };
  }

  /** The other attachments of the blob's message (a GET of the message; its fresh links are kept for reads). */
  async extrasOf(p: Placement, _signal?: AbortSignal): Promise<ExtraPlacement[]> {
    if (!isDiscordPlacement(p)) throw new Error(`not a Discord placement: ${p.provider}`);
    const atts = await this.dw.messageAttachments(p);
    return atts.filter((a) => a.id !== p.attachmentId).map((a) => extraOf(p, a));
  }

  async addExtras(p: Placement, extras: ExtraFile[]): Promise<ExtraPlacement[]> {
    if (!isDiscordPlacement(p)) throw new Error(`not a Discord placement: ${p.provider}`);
    const t = this.dw.transport;
    if (!t.addFiles) throw new Error("this transport cannot edit messages");
    const now = await this.dw.messageAttachments(p, true);
    const atts = await t.addFiles(this.hook, p.messageId, now.map((a) => a.id), extras);
    this.dw.rememberLinks(p, atts);
    return atts.filter((a) => a.id !== p.attachmentId).map((a) => extraOf(p, a));
  }

  get(p: Placement, signal?: AbortSignal, ctx?: BlobGetContext): Promise<Uint8Array> {
    if (!isDiscordPlacement(p)) throw new Error(`not a Discord placement: ${p.provider}`);
    return this.dw.read(p, signal, ctx);
  }

  async remove(p: Placement): Promise<"deleted" | "gone"> {
    if (!isDiscordPlacement(p)) throw new Error(`not a Discord placement: ${p.provider}`);
    try {
      await this.dw.transport.deleteMessage(this.hook, p.messageId);
      return "deleted";
    } catch (e) {
      if (isGone(e)) return "gone";
      throw e;
    }
  }

  async inspect(): Promise<{ label: string; paceKey: string }> {
    const i = await this.dw.transport.inspectWebhook(this.hook);
    this.hook.channelId ??= i.channelId;
    return { label: i.name, paceKey: i.channelId };
  }

  setCdnLanes(lanes: LaneFetch[]): void {
    this.dw.setCdnLanes(lanes);
  }
}
