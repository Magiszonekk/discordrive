// Metadata-only client (koncept §3.1): DriveClient whose blobs go straight
// between the device and the user's webhooks (WebhookBlobStore); only the
// index operation goes through the arbiter. Works in Node and in the browser
// (fetch + WebCrypto). Marker for the build-time mode check: ddn-webhook-vault.

import type { ArbiterApi } from "./arbiter.js";
import type { BlobPutContext, BlobStore } from "./blob-store.js";
import { RateLimitedError } from "./discord-transport.js";
import { DriveClient } from "./drive-client.js";
import { ChannelPacer } from "./rate-limit.js";
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
  /** Webhooks from the user's vault (koncept §3.2). Fragments are spread over their channels. */
  webhooks: WebhookRef[];
  store?: IndexStore;
  pacer?: ChannelPacer;
  chunkSize?: number;
  /** Fragments in flight at once (the pacer still gates per channel). */
  concurrency?: number;
  /** Retries per fragment for non-429 errors. */
  maxRetries?: number;
  /** Renew the upload lease at least this often (ms). */
  leaseRenewMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Q10: called once per device that reached INVALID_OP_WARN_AFTER invalid ops. */
  onInvalidOps?: (a: InvalidOpAlert) => void;
}

/** Blobs on the user's webhooks, paced per channel on this device (koncept §7, §8.2). */
export class WebhookBlobStore implements BlobStore {
  readonly marker = WEBHOOK_VAULT_MARKER;
  readonly pacer: ChannelPacer;
  readonly hooks: Map<string, WebhookRef>;
  private rr = 0;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly transport: WebhookTransport,
    webhooks: WebhookRef[],
    o: { pacer?: ChannelPacer; maxRetries?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (webhooks.length === 0) throw new Error("no webhooks");
    this.hooks = new Map(webhooks.map((h) => [h.id, h]));
    this.pacer = o.pacer ?? new ChannelPacer({ now: o.now, sleep: o.sleep });
    this.maxRetries = o.maxRetries ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Webhooks that take new pieces: not retired, not excluded by the caller (a move posts only to the targets). */
  private nextHook(exclude?: ReadonlySet<string>): WebhookRef {
    const all = [...this.hooks.values()].filter((h) => !h.retired && !exclude?.has(h.id));
    if (!all.length) throw new Error("need_channel: no active channel to post to");
    return all[this.rr++ % all.length]!;
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
    return placementOf(await this.post(data, filename, ctx.stats ?? { posts: 0 }));
  }

  /** Post one blob with pacing per channel and retries (round-robin over the active webhooks, minus `exclude`). */
  async post(data: Uint8Array, filename: string, stats: { posts: number }, exclude?: ReadonlySet<string>): Promise<PostedAttachment> {
    return this.postOn(() => this.nextHook(exclude), data, filename, stats);
  }

  private async postOn(pick: () => WebhookRef, data: Uint8Array, filename: string, stats: { posts: number }): Promise<PostedAttachment> {
    let attempt = 0;
    for (;;) {
      const hook = pick();
      const key = hook.channelId ?? `hook:${hook.id}`;
      await this.pacer.acquire(key);
      stats.posts++;
      try {
        const res = await this.transport.postFile(hook, data, filename);
        if (!hook.channelId) hook.channelId = res.channelId;
        this.pacer.onSuccess(key);
        return res;
      } catch (e) {
        if (e instanceof RateLimitedError) {
          this.pacer.onRateLimited(key, e.retryAfterMs, e.scope);
          if (e.global && e.retryAfterMs > 60_000) throw e;
          continue; // 429s do not count against maxRetries: the pacer slows down instead
        }
        if (++attempt > this.maxRetries) throw e;
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  /** Fetch a stored attachment through its webhook (fresh signed CDN link, koncept §7). */
  async get(p: DiscordPlacement): Promise<Uint8Array> {
    const hook = this.hook(p.locationId);
    let attempt = 0;
    for (;;) {
      try {
        const atts = await this.transport.getAttachments(hook, p.messageId);
        const a = atts.find((x) => x.id === p.attachmentId);
        if (!a) throw new Error("attachment missing from message");
        return await this.transport.fetchCdn(a.url);
      } catch (e) {
        if (e instanceof RateLimitedError) {
          await this.sleep(e.retryAfterMs);
          continue;
        }
        if (++attempt > this.maxRetries) throw e;
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
  }
}

export class MetadataClient extends DriveClient {
  readonly pacer: ChannelPacer;
  private readonly wh: WebhookBlobStore;

  constructor(o: MetadataClientOptions) {
    const wh = new WebhookBlobStore(o.transport, o.webhooks, { pacer: o.pacer, maxRetries: o.maxRetries, now: o.now, sleep: o.sleep });
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
