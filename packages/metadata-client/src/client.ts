// Metadata-only client: upload/download straight between the device and the
// user's webhooks; only the index operation goes through the arbiter
// (koncept §3.1). Works in Node and in the browser (fetch + WebCrypto).
//
// Upload protocol (rule 8, sync-core Sequencer comment):
//   renewLease(U) -> upload_begin [guard U], confirmed in the log ->
//   fragments (lease renewed while they go) -> manifest fragment ->
//   group[upload_commit U, create(content)] [guard U] -> releaseLease(U).
//
// NOTE (until plan step 3, op encryption): the op payload carries the file key
// inside manifestRef in plaintext. That is fine for the in-process arbiter
// used by the CLI and tests, but this log must not be sent to a server before
// ops are encrypted.

import { createSHA256 } from "hash-wasm";
import {
  ROOT_ID,
  normalizeName,
  validateName,
  type ApplyResult,
  type ChunkManifest,
  type ChunkRef,
  type ContentRef,
  type DeviceInfo,
  type FileVersion,
  type NodeId,
  type Operation,
  Replica,
  type IndexStore,
} from "@ddv4/sync-core";
import type { ArbiterApi } from "./arbiter.js";
import { RateLimitedError } from "./discord-transport.js";
import {
  FRAGMENT_FORMAT_VERSION,
  decryptFragment,
  decryptManifest,
  encryptFragment,
  encryptManifest,
  importFileKey,
  newFileKey,
  sha256Hex,
  type FileKey,
} from "./file-crypto.js";
import { ChannelPacer } from "./rate-limit.js";
import { LogObserver, type InvalidOpAlert } from "./policies.js";
import type { DiscordPlacement, PostedAttachment, WebhookRef, WebhookTransport } from "./types.js";

/** Plaintext fragment size; same as discordrive (10 MiB on the wire incl. 28 B of IV + tag). */
export const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024 - 28;
/**
 * Attachment file extension for everything we post (fragments, manifests,
 * snapshots). Measured 2026-10-09: Discord's CDN sends CORS headers only for
 * some content types, chosen by extension (.txt/.json/.webm/.png yes;
 * .bin/.dat/none no), so a browser can read only those. The bytes are the
 * same ciphertext as before (format §6.2 unchanged); only the name differs.
 */
export const BLOB_EXT = ".txt";
export const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_REF_PREFIX = "ddn1:";

/** Random URL-safe ID accepted by sync-core isClientId (22 chars). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random-access plaintext source (Node file handle, browser Blob, memory). */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface ByteSink {
  write(data: Uint8Array): Promise<void>;
}

export function memorySource(data: Uint8Array): ByteSource {
  return { size: data.byteLength, read: async (o, l) => data.subarray(o, Math.min(o + l, data.byteLength)) };
}

/** What manifestRef decodes to. Lives only in the (to be encrypted) op payload and tree. */
export interface ManifestLocator {
  v: 1;
  /** File root key, base64 (koncept: key per file). */
  k: string;
  /** Where the encrypted manifest is. */
  at: DiscordPlacement;
  /** Fragment format version. */
  f: number;
}

export function encodeManifestRef(loc: ManifestLocator): string {
  const at = loc.at;
  return `${MANIFEST_REF_PREFIX}${JSON.stringify([loc.v, loc.f, loc.k, at.locationId, at.channelId, at.messageId, at.attachmentId])}`;
}

export function decodeManifestRef(ref: string): ManifestLocator {
  if (!ref.startsWith(MANIFEST_REF_PREFIX)) throw new Error("unknown manifestRef format");
  const a = JSON.parse(ref.slice(MANIFEST_REF_PREFIX.length)) as unknown[];
  if (!Array.isArray(a) || a[0] !== 1 || a.length !== 7 || !a.every((x) => typeof x === "string" || typeof x === "number")) {
    throw new Error("bad manifestRef");
  }
  return {
    v: 1,
    f: a[1] as number,
    k: a[2] as string,
    at: { provider: "discord-webhook", locationId: String(a[3]), channelId: String(a[4]), messageId: String(a[5]), attachmentId: String(a[6]) },
  };
}

export class OpFailedError extends Error {
  constructor(
    readonly result: ApplyResult | { status: string },
    what: string,
  ) {
    super(`${what}: ${"outcome" in result ? result.outcome : result.status}`);
    this.name = "OpFailedError";
  }
}

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

export interface UploadOptions {
  /** Plaintext bytes whose fragments are on Discord so far (called after each fragment). */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

export interface UploadResult {
  nodeId: NodeId;
  uploadId: string;
  version: ContentRef;
  chunks: number;
  posts: number;
}

export class MetadataClient {
  readonly replica: Replica;
  readonly pacer: ChannelPacer;
  /** Log-derived facts for client policies (Q4 last purge, Q5 non-NFC names, Q10 invalid ops). */
  readonly observer = new LogObserver();
  private readonly hooks: Map<string, WebhookRef>;
  private rr = 0;
  private readonly chunkSize: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly leaseRenewMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: MetadataClientOptions) {
    if (o.webhooks.length === 0) throw new Error("no webhooks");
    this.replica = new Replica({ device: o.device, store: o.store, newOpId: newId, now: o.now });
    this.pacer = o.pacer ?? new ChannelPacer({ now: o.now, sleep: o.sleep });
    this.hooks = new Map(o.webhooks.map((h) => [h.id, h]));
    this.chunkSize = o.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.concurrency = Math.max(1, o.concurrency ?? 3);
    this.maxRetries = o.maxRetries ?? 4;
    this.leaseRenewMs = o.leaseRenewMs ?? 60_000;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get store(): IndexStore {
    return this.replica.store;
  }

  /** Pull the log tail from the arbiter. */
  async pull(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    for (;;) {
      const batch = await this.o.arbiter.read(this.replica.headSeq, 1000);
      if (batch.length === 0) return out;
      // One transaction per batch: on OPFS a transaction per entry measured
      // 14.3 ms/entry vs 0.44 ms/entry batched (Chromium, opfs-check.ts).
      // Per-entry atomicity is unchanged: apply() still commits each entry's
      // overlay as a whole, nested inside this transaction.
      const results = this.store.atomically(() => this.replica.receive(batch));
      const byOp = new Map(batch.map((e) => [e.opId, e]));
      for (const r of results) {
        const e = byOp.get(r.opId);
        const alert = e ? this.observer.observe(e, r) : null;
        if (alert) this.o.onInvalidOps?.(alert);
      }
      out.push(...results);
    }
  }

  /** Submit one op and wait until it is applied locally; throws unless applied/noop. */
  async commitOp(op: Operation, what: string): Promise<ApplyResult> {
    const env = this.replica.enqueue(op);
    await this.pull();
    // Rule 10: own ops go after catching up; send everything queued before ours too.
    while (this.replica.unsent > 0) {
      const head = this.replica.nextToSend()!;
      const r = await this.replica.pushOneAsync(this.o.arbiter);
      if (!r) break;
      if (r.status !== "accepted" && r.status !== "duplicate") {
        // Refused (rules version, lease): the op will never be in the log.
        this.replica.drop(head.opId);
        if (head.opId === env.opId) throw new OpFailedError(r, what);
      }
    }
    const results = await this.pull();
    const mine = results.find((r) => r.opId === env.opId) ?? this.replica.results.find((r) => r.opId === env.opId);
    if (!mine) throw new Error(`${what}: op not in log`);
    if (mine.outcome !== "applied" && mine.outcome !== "noop") throw new OpFailedError(mine, what);
    return mine;
  }

  private nextHook(): WebhookRef {
    const all = [...this.hooks.values()];
    return all[this.rr++ % all.length]!;
  }

  private hookById(id: string): WebhookRef {
    const h = this.hooks.get(id);
    if (!h) throw new Error(`webhook ${id} not in vault`);
    return h;
  }

  /** Post one blob (any kind: fragment, manifest, snapshot part) with per-channel pacing and retries. */
  async postBlob(data: Uint8Array, filename: string): Promise<DiscordPlacement> {
    return placementOf(await this.post(data, filename, { posts: 0 }));
  }

  /** Webhook from the vault by ID (throws if unknown). */
  webhook(id: string): WebhookRef {
    return this.hookById(id);
  }

  /** The webhooks this client posts through. */
  get webhooks(): WebhookRef[] {
    return [...this.hooks.values()];
  }

  /** Post one blob with pacing per channel and retries. */
  private async post(data: Uint8Array, filename: string, stats: { posts: number }): Promise<PostedAttachment> {
    let attempt = 0;
    for (;;) {
      const hook = this.nextHook();
      const key = hook.channelId ?? `hook:${hook.id}`;
      await this.pacer.acquire(key);
      stats.posts++;
      try {
        const res = await this.o.transport.postFile(hook, data, filename);
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
  async fetchPlacement(p: DiscordPlacement): Promise<Uint8Array> {
    const hook = this.hookById(p.locationId);
    let attempt = 0;
    for (;;) {
      try {
        const atts = await this.o.transport.getAttachments(hook, p.messageId);
        const a = atts.find((x) => x.id === p.attachmentId);
        if (!a) throw new Error("attachment missing from message");
        return await this.o.transport.fetchCdn(a.url);
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

  /**
   * Upload a file into `parentId` under `name` (NFC-normalized, Q5).
   * Returns once the create is applied in the local replica.
   */
  async upload(src: ByteSource, name: string, parentId: NodeId = ROOT_ID, opts: UploadOptions = {}): Promise<UploadResult> {
    const nfc = normalizeName(name);
    const bad = validateName(nfc);
    if (bad) throw new Error(`invalid name: ${bad}`);
    const deviceId = this.o.device.id;
    const uploadId = newId();
    const nodeId = newId();
    const stats = { posts: 0 };

    if (!(await this.o.arbiter.renewLease(uploadId, deviceId))) throw new Error("lease refused");
    let lastRenew = this.now();
    const renew = async () => {
      if (this.now() - lastRenew < this.leaseRenewMs) return;
      lastRenew = this.now();
      if (!(await this.o.arbiter.renewLease(uploadId, deviceId))) throw new Error("upload lease lost");
    };

    await this.commitOp({ type: "upload_begin", uploadId }, "upload_begin");

    const key = await newFileKey();
    const count = Math.max(1, Math.ceil(src.size / this.chunkSize));
    const chunks: ChunkRef[] = new Array(count);
    const hasher = await createSHA256();
    hasher.init();
    // Plaintext hash must be computed in order; fragments may finish out of order.
    let hashedUpTo = 0;
    const plain = new Map<number, Uint8Array>();
    const feedHash = () => {
      while (plain.has(hashedUpTo)) {
        hasher.update(plain.get(hashedUpTo)!);
        plain.delete(hashedUpTo);
        hashedUpTo++;
      }
    };

    let next = 0;
    let sentBytes = 0;
    opts.onProgress?.(0, src.size);
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= count) return;
        await renew();
        const data = await src.read(i * this.chunkSize, this.chunkSize);
        const ct = await encryptFragment(key, data);
        const blobId = newId();
        const posted = await this.post(ct, `${blobId}${BLOB_EXT}`, stats);
        chunks[i] = {
          index: i,
          blobId,
          ciphertextSizeBytes: ct.byteLength,
          ciphertextHash: await sha256Hex(ct),
          placements: [placementOf(posted)],
        };
        plain.set(i, data);
        feedHash();
        sentBytes += data.byteLength;
        opts.onProgress?.(sentBytes, src.size);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, count) }, worker));
      feedHash();
      const plaintextSha256 = hasher.digest("hex");

      const manifest: ChunkManifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, chunkSizeBytes: this.chunkSize, chunks };
      const mct = await encryptManifest(key, manifest);
      await renew();
      const mposted = await this.post(mct, `${newId()}${BLOB_EXT}`, stats);
      const version: ContentRef = {
        versionId: newId(),
        uploadId,
        sizeBytes: src.size,
        manifestRef: encodeManifestRef({ v: 1, f: FRAGMENT_FORMAT_VERSION, k: key.rawB64, at: placementOf(mposted) }),
        chunkCount: count,
        plaintextSha256,
      };
      await renew();
      await this.commitOp(
        {
          type: "group",
          ops: [
            { type: "upload_commit", uploadId },
            { type: "create", kind: "file", nodeId, parentId, name: nfc, content: version },
          ],
        },
        "upload_commit+create",
      );
      return { nodeId, uploadId, version, chunks: count, posts: stats.posts };
    } finally {
      await this.o.arbiter.releaseLease(uploadId, deviceId);
    }
  }

  /** Manifests are immutable per version: small LRU (koncept §4.1, manifest layer on demand). */
  private readonly manifests = new Map<string, Promise<{ manifest: ChunkManifest; key: FileKey }>>();
  /** Manifest fetches from Discord (diagnostics/tests). */
  manifestLoads = 0;

  /** Load and decrypt the manifest of a version (koncept §4.1: manifests on demand, cached). */
  async loadManifest(manifestRef: string): Promise<{ manifest: ChunkManifest; key: FileKey }> {
    const hit = this.manifests.get(manifestRef);
    if (hit) {
      this.manifests.delete(manifestRef);
      this.manifests.set(manifestRef, hit);
      return hit;
    }
    const p = this.fetchManifest(manifestRef);
    this.manifests.set(manifestRef, p);
    p.catch(() => this.manifests.delete(manifestRef));
    while (this.manifests.size > 256) this.manifests.delete(this.manifests.keys().next().value!);
    return p;
  }

  private async fetchManifest(manifestRef: string): Promise<{ manifest: ChunkManifest; key: FileKey }> {
    this.manifestLoads++;
    const loc = decodeManifestRef(manifestRef);
    if (loc.f !== FRAGMENT_FORMAT_VERSION) throw new Error(`unsupported fragment format ${loc.f}`);
    const key = await importFileKey(loc.k);
    const manifest = await decryptManifest(key, await this.fetchPlacement(loc.at));
    return { manifest, key };
  }

  /**
   * Download the current version of a file node into `sink`, verifying every
   * fragment's ciphertext hash and the whole-file plaintext SHA-256.
   */
  async download(nodeId: NodeId, sink: ByteSink): Promise<FileVersion> {
    const node = this.store.getNode(nodeId);
    if (!node || node.kind !== "file" || !node.content) throw new Error("not a file");
    const v = node.content;
    const { manifest, key } = await this.loadManifest(v.manifestRef);
    if (manifest.chunks.length !== v.chunkCount) throw new Error("manifest chunk count mismatch");
    const hasher = await createSHA256();
    hasher.init();
    let total = 0;
    for (const c of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
      const p = c.placements?.[0] as DiscordPlacement | undefined;
      if (!p) throw new Error(`chunk ${c.index}: no placement`);
      const ct = await this.fetchPlacement(p);
      if (c.ciphertextHash && (await sha256Hex(ct)) !== c.ciphertextHash) throw new Error(`chunk ${c.index}: ciphertext hash mismatch`);
      const pt = await decryptFragment(key, ct);
      hasher.update(pt);
      total += pt.byteLength;
      await sink.write(pt);
    }
    if (total !== v.sizeBytes) throw new Error(`size mismatch: ${total} != ${v.sizeBytes}`);
    const h = hasher.digest("hex");
    if (v.plaintextSha256 && h !== v.plaintextSha256) throw new Error("plaintext SHA-256 mismatch");
    return v;
  }

  /**
   * Bytes [start, end] (inclusive, like HTTP Range) of a file's current
   * version, fetching only the fragments that overlap (koncept §3.1: video
   * streaming via service worker + Range). Every fetched fragment is checked
   * against its ciphertext hash; the whole-file SHA-256 cannot be checked on
   * a partial read, AES-GCM still authenticates every fragment.
   * `cache` lets a caller (service worker) keep decrypted fragments between requests.
   */
  async readRange(
    nodeId: NodeId,
    start: number,
    end: number,
    cache?: Map<string, Uint8Array>,
  ): Promise<{ data: Uint8Array; size: number; start: number; end: number }> {
    const node = this.store.getNode(nodeId);
    if (!node || node.kind !== "file" || !node.content) throw new Error("not a file");
    const size = node.content.sizeBytes;
    if (size === 0) return { data: new Uint8Array(0), size, start: 0, end: -1 };
    if (!(start >= 0 && start < size)) throw new RangeError(`range start ${start} outside 0..${size - 1}`);
    end = Math.min(end, size - 1);
    if (end < start) throw new RangeError("empty range");
    const { manifest, key } = await this.loadManifest(node.content.manifestRef);
    const cs = manifest.chunkSizeBytes;
    const out = new Uint8Array(end - start + 1);
    const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
    for (let i = Math.floor(start / cs); i <= Math.floor(end / cs); i++) {
      const c = chunks[i];
      if (!c || c.index !== i) throw new Error(`manifest has no chunk ${i}`);
      const ck = `${node.content.versionId}:${i}`;
      let pt = cache?.get(ck);
      if (!pt) {
        const ct = await this.fetchPlacement(c.placements![0] as DiscordPlacement);
        if (c.ciphertextHash && (await sha256Hex(ct)) !== c.ciphertextHash) throw new Error(`chunk ${i}: ciphertext hash mismatch`);
        pt = await decryptFragment(key, ct);
        cache?.set(ck, pt);
      }
      const from = Math.max(start, i * cs) - i * cs;
      const to = Math.min(end, i * cs + pt.byteLength - 1) - i * cs;
      out.set(pt.subarray(from, to + 1), Math.max(start, i * cs) - start);
    }
    return { data: out, size, start, end };
  }

  /** Children of a folder (non-trashed), sorted by name. */
  list(parentId: NodeId = ROOT_ID): { id: NodeId; name: string; kind: string; size: number | null }[] {
    const out = [];
    for (const id of this.store.childIds(parentId)) {
      const n = this.store.getNode(id);
      if (!n || n.trashed) continue;
      out.push({ id, name: n.name, kind: n.kind, size: n.content?.sizeBytes ?? null });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}

function placementOf(p: PostedAttachment): DiscordPlacement {
  return { provider: "discord-webhook", locationId: p.webhookId, channelId: p.channelId, messageId: p.messageId, attachmentId: p.attachmentId };
}
