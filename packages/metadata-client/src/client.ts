// Metadata-only client: DriveClient whose blobs go straight between the
// device and the user's backends (WebhookBlobStore); only the
// index operation goes through the arbiter. Works in Node and in the browser
// (fetch + WebCrypto). Marker for the build-time mode check: ddn-webhook-vault.

import type { ArbiterApi } from "./arbiter.js";
import { BackendBlobStore, BackendRegistry, DiscordWebhooks, placementOf, type BlobBackend } from "./backends.js";
import type { NetControl } from "./net.js";
import { DriveClient, type ResumeStore } from "./drive-client.js";
import { ChannelPacer } from "./rate-limit.js";
import type { LinkAhead, LinkAheadOptions } from "./link-ahead.js";
import type { InvalidOpAlert } from "./policies.js";
import type { Placement, WebhookRef, WebhookTransport } from "./types.js";
import type { DeviceInfo, IndexStore } from "@ddv4/sync-core";

export {
  DEFAULT_CHUNK_SIZE,
  BLOB_EXT,
  MANIFEST_SCHEMA_VERSION,
  OpFailedError,
  decodeManifestRef,
  encodeManifestRef,
  MANIFEST_REF_MAX,
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
  /** Other storage backends from the vault (spread over together with the webhooks). */
  backends?: BlobBackend[];
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

/**
 * Blobs on the user's backends from the vault, paced per backend limiter key on this device: the Discord
 * webhooks (one DiscordWebhooks: transport, links fetched ahead, retries) plus any other backends.
 */
export class WebhookBlobStore extends BackendBlobStore {
  readonly marker = WEBHOOK_VAULT_MARKER;
  readonly discord: DiscordWebhooks;

  constructor(
    transport: WebhookTransport,
    webhooks: WebhookRef[],
    o: { pacer?: ChannelPacer; maxRetries?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; links?: LinkAheadOptions; backends?: BlobBackend[] } = {},
  ) {
    const rt = { log: null, net: null };
    const dw = new DiscordWebhooks(transport, rt, { maxRetries: o.maxRetries, sleep: o.sleep, links: o.links });
    super(new BackendRegistry([...webhooks.map((h) => dw.backend(h)), ...(o.backends ?? [])]), { ...o, rt });
    this.discord = dw;
  }

  get transport(): WebhookTransport {
    return this.discord.transport;
  }
  get links(): LinkAhead {
    return this.discord.links;
  }
  /** The Discord webhooks (refs; their channel IDs are learned from the first post). */
  get hooks(): Map<string, WebhookRef> {
    return this.discord.hooks;
  }
  hook(id: string): WebhookRef {
    return this.discord.hook(id);
  }
}

export class MetadataClient extends DriveClient {
  readonly pacer: ChannelPacer;
  private readonly wh: WebhookBlobStore;

  constructor(o: MetadataClientOptions) {
    const wh = new WebhookBlobStore(o.transport, o.webhooks, { pacer: o.pacer, maxRetries: o.maxRetries, now: o.now, sleep: o.sleep, links: o.links, backends: o.backends });
    super({ ...o, blobs: wh });
    this.wh = wh;
    this.pacer = wh.pacer;
  }

  /** Post one blob (any kind: fragment, manifest, snapshot part) with per-channel pacing and retries. */
  async postBlob(data: Uint8Array, filename: string): Promise<Placement> {
    return this.wh.put(data, filename);
  }

  /** Post one blob to the active backends except `exclude` (moving a channel's data away). */
  async postBlobExcept(data: Uint8Array, filename: string, exclude: ReadonlySet<string>): Promise<Placement> {
    return this.wh.post(data, filename, { posts: 0 }, exclude);
  }

  /** Post one blob to one given backend (snapshot objects: only on the pointer's channel). */
  async postBlobTo(hookId: string, data: Uint8Array, filename: string): Promise<Placement> {
    return this.wh.postTo(hookId, data, filename);
  }

  /** Delete one stored blob ("gone" = it was not there any more). */
  async removeBlob(p: Placement): Promise<"deleted" | "gone"> {
    return this.wh.remove(p);
  }

  /** The account's backends (Discord webhooks and others). */
  get registry(): BackendRegistry {
    return this.wh.registry;
  }

  /** Backend from the vault by ID (throws if unknown). */
  backend(id: string): BlobBackend {
    return this.wh.backend(id);
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

  /** Stop/resume posting to one backend in this client (the vault flag is the durable part). */
  setHookRetired(id: string, retired: boolean): void {
    const b = this.wh.registry.byId(id);
    if (b) b.retired = retired;
  }
}

export { placementOf };
