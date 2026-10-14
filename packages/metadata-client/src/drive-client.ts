// Client core shared by every mode (koncept §2): index (sync-core replica),
// operation log through the arbiter, per-file keys and fragment encryption in
// the discordrive format, manifests on demand, download/Range reads.
// WHERE the encrypted blobs go is a BlobStore chosen by the mode:
//   metadata only -> WebhookBlobStore (client.ts, user's webhooks),
//   e2ee / plain  -> ServerBlobStore (server-blobs.ts, the instance posts).
//
// Upload protocol (rule 8, sync-core Sequencer comment):
//   renewLease(U) -> upload_begin [guard U], confirmed in the log ->
//   fragments (lease renewed while they go) -> manifest blob ->
//   blobs.finalize(U) -> group[upload_commit U, create(content)] [guard U] -> releaseLease(U).

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
  type PieceLoc,
  Replica,
  type IndexStore,
} from "@ddv4/sync-core";
import type { ArbiterApi } from "./arbiter.js";
import { AbortedError, throwIfAborted, type BlobStore } from "./blob-store.js";
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
import { LogObserver, type InvalidOpAlert } from "./policies.js";
import { errText, ms, nowMs, type TransferLog } from "./transfer-log.js";
import type { DiscordPlacement } from "./types.js";

/**
 * Upper bound of fragments in flight (owner, 2026-10-14: up to 64 to saturate a ~600 Mb/s line). Each
 * upload fragment in flight holds ~2 × 10 MiB (ciphertext + request body), a download one ~2 × 10 MiB.
 */
export const MAX_CONCURRENCY = 64;
/** The automatic upload value stays modest: 2 × channels (Discord's per-channel limit makes more useless). */
export const AUTO_CONCURRENCY_MAX = 32;
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

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

/** What manifestRef decodes to. Lives only in the (encrypted, except plain) op payload and tree. */
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

export interface DriveClientOptions {
  device: DeviceInfo;
  arbiter: ArbiterApi;
  blobs: BlobStore;
  store?: IndexStore;
  chunkSize?: number;
  /**
   * Upload fragments in flight at once (a store may still gate per channel). Default: twice the
   * channels the store spreads over (BlobStore.lanes), at least 3, at most MAX_CONCURRENCY.
   */
  concurrency?: number;
  /** Download fragments in flight at once (fetched in parallel, written in order). Default 4. */
  downloadConcurrency?: number;
  /** Renew the upload lease at least this often (ms). */
  leaseRenewMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Q10: called once per device that reached INVALID_OP_WARN_AFTER invalid ops. */
  onInvalidOps?: (a: InvalidOpAlert) => void;
}

/** Fragments of an upload per stage right now (live view: encrypting vs sending). */
export interface UploadStages {
  /** Reading + encrypting + hashing. */
  enc: number;
  /** Waiting for the limiter or on the wire. */
  net: number;
}

export interface UploadOptions {
  /** Plaintext bytes whose fragments are stored so far (called after each fragment and on stage changes). */
  onProgress?: (doneBytes: number, totalBytes: number, stages?: UploadStages) => void;
  /** Cancel: stops the fragment in flight; the store drops what was sent (e2ee/plain). */
  signal?: AbortSignal;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Plaintext bytes written to the sink so far. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

export interface UploadResult {
  nodeId: NodeId;
  uploadId: string;
  version: ContentRef;
  chunks: number;
  posts: number;
}

export class DriveClient {
  readonly replica: Replica;
  /** Log-derived facts for client policies (Q4 last purge, Q5 non-NFC names, Q10 invalid ops). */
  readonly observer = new LogObserver();
  readonly blobs: BlobStore;
  protected readonly chunkSize: number;
  /** Fixed upload concurrency (option / setting); null = automatic from the store's lanes. */
  private concurrencyOpt: number | null;
  private downloadConc: number;
  protected readonly leaseRenewMs: number;
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  /** Transfer log (Settings → Diagnostics); null = off. */
  tlog: TransferLog | null = null;

  constructor(protected readonly d: DriveClientOptions) {
    this.replica = new Replica({ device: d.device, store: d.store, newOpId: newId, now: d.now });
    this.blobs = d.blobs;
    this.chunkSize = d.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.concurrencyOpt = d.concurrency ? clampConc(d.concurrency) : null;
    this.downloadConc = clampConc(d.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY);
    this.leaseRenewMs = d.leaseRenewMs ?? 60_000;
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get store(): IndexStore {
    return this.replica.store;
  }

  /** Turn transfer logs on (a TransferLog) or off (null) for this client and its blob store. */
  setTransferLog(l: TransferLog | null): void {
    this.tlog = l;
    this.blobs.log = l;
  }

  /** Fragments in flight at once for uploads: the setting, else max(3, 2 × the store's channels) (zlecenie 2026-10-13-transfer §3). */
  get uploadConcurrency(): number {
    return this.concurrencyOpt ?? Math.min(AUTO_CONCURRENCY_MAX, clampConc(Math.max(3, 2 * (this.blobs.lanes?.() ?? 1))));
  }

  get downloadConcurrency(): number {
    return this.downloadConc;
  }

  /** Settings → Diagnostics → advanced: fragments in flight (null / 0 = automatic upload, default download). */
  setConcurrency(o: { upload?: number | null; download?: number | null }): void {
    if (o.upload !== undefined) this.concurrencyOpt = o.upload ? clampConc(o.upload) : null;
    if (o.download !== undefined) this.downloadConc = o.download ? clampConc(o.download) : DEFAULT_DOWNLOAD_CONCURRENCY;
  }

  /** Pull the log tail from the arbiter. */
  async pull(): Promise<ApplyResult[]> {
    const out: ApplyResult[] = [];
    for (;;) {
      const batch = await this.d.arbiter.read(this.replica.headSeq, 1000);
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
        if (alert) this.d.onInvalidOps?.(alert);
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
      const r = await this.replica.pushOneAsync(this.d.arbiter);
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

  /** Fetch one stored blob (fresh link, retries: the store's business). */
  async fetchPlacement(p: DiscordPlacement): Promise<Uint8Array> {
    return this.blobs.get(p);
  }

  /**
   * Upload a file into `parentId` under `name` (NFC-normalized, Q5).
   * Returns once the create is applied in the local replica.
   */
  async upload(src: ByteSource, name: string, parentId: NodeId = ROOT_ID, opts: UploadOptions = {}): Promise<UploadResult> {
    const nfc = normalizeName(name);
    const bad = validateName(nfc);
    if (bad) throw new Error(`invalid name: ${bad}`);
    const signal = opts.signal;
    throwIfAborted(signal);
    const deviceId = this.d.device.id;
    const uploadId = newId();
    const nodeId = newId();
    const stats = { posts: 0 };
    const log = this.tlog;
    const t0 = nowMs();
    const nFrags = Math.max(1, Math.ceil(src.size / this.chunkSize));
    const conc = Math.min(this.uploadConcurrency, nFrags);
    log?.emit("file_start", { dir: "up", x: uploadId, size: src.size, n: nFrags, chunk: this.chunkSize, conc, lanes: this.blobs.lanes?.() ?? null, mode: log.o.mode, ...log.nameFields(nfc) });
    let sentBytes = 0;
    const endLog = (ok: boolean, e?: unknown) =>
      log?.emit("file_end", { dir: "up", x: uploadId, ok, size: src.size, b: sentBytes, dur: ms(t0), mbps: mbps(sentBytes, ms(t0)), posts: stats.posts, ...(ok ? {} : { err: e instanceof Error && e.name === "AbortError" ? "aborted" : errText(e) }) });

    if (!(await this.d.arbiter.renewLease(uploadId, deviceId))) {
      endLog(false, new Error("lease refused"));
      throw new Error("lease refused");
    }
    let lastRenew = this.now();
    const renew = async () => {
      if (this.now() - lastRenew < this.leaseRenewMs) return;
      lastRenew = this.now();
      if (!(await this.d.arbiter.renewLease(uploadId, deviceId))) throw new Error("upload lease lost");
    };
    let committed = false;
    try {
      await this.commitOp({ type: "upload_begin", uploadId }, "upload_begin");

      const key = await newFileKey();
      const count = Math.max(1, Math.ceil(src.size / this.chunkSize));
      const chunks: ChunkRef[] = new Array(count);
      const hasher = await createSHA256();
      hasher.init();
      // The whole-file plaintext hash must be fed in order. Reads run in parallel (each fragment's own),
      // the hash takes them in index order as soon as each is read (not after its post, as before), so a
      // fragment's plaintext is dropped right after it is encrypted and hashed: memory follows the
      // fragments in flight, not the slowest post (owner's note 2026-10-14: 30–60 in flight).
      let hashChain: Promise<unknown> = Promise.resolve();
      const readInOrder = (i: number): Promise<{ data: Uint8Array; rd: number; ph: number }> => {
        const r0 = nowMs();
        const read = src.read(i * this.chunkSize, this.chunkSize).then((data) => ({ data, rd: ms(r0) }));
        const hashed = hashChain.then(() => read).then((x) => {
          const h0 = nowMs();
          hasher.update(x.data);
          return ms(h0);
        });
        hashChain = hashed.catch(() => {});
        return Promise.all([read, hashed]).then(([x, ph]) => ({ data: x.data, rd: x.rd, ph }));
      };
      let next = 0;
      const stages: UploadStages = { enc: 0, net: 0 };
      opts.onProgress?.(0, src.size, { ...stages });
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= count) return;
          throwIfAborted(signal);
          // Queued at once (same tick as taking i), so the hash stays in index order.
          const reading = readInOrder(i);
          reading.catch(() => {});
          await renew();
          stages.enc++;
          opts.onProgress?.(sentBytes, src.size, { ...stages });
          if (log) log.fl.up++;
          const f0 = log ? nowMs() : 0;
          let f1 = 0, f2 = 0, f3 = 0;
          try {
            const rd = await reading;
            const data = rd.data;
            if (log) f1 = nowMs();
            const ct = await encryptFragment(key, data);
            if (log) f2 = nowMs();
            const blobId = newId();
            const hash = await sha256Hex(ct);
            if (log) f3 = nowMs();
            stages.enc--;
            stages.net++;
            opts.onProgress?.(sentBytes, src.size, { ...stages });
            const placed = await this.blobs.put(ct, `${blobId}${BLOB_EXT}`, { uploadId, index: i, sha256: hash, signal, stats });
            stages.net--;
            chunks[i] = { index: i, blobId, ciphertextSizeBytes: ct.byteLength, ciphertextHash: hash, placements: [placed] };
            const f4 = log ? nowMs() : 0;
            sentBytes += data.byteLength;
            // rd = from the worker taking the fragment to it being read and hashed in order; ph = the hash step.
            if (log) log.emit("frag", { dir: "up", x: uploadId, i, pb: data.byteLength, b: ct.byteLength, rd: ms(f0, f1), enc: ms(f1, f2), hash: ms(f2, f3), put: ms(f3, f4), ph: rd.ph, dur: ms(f0), hook: placed.locationId, ch: placed.channelId ?? null, fl: log.fl.up });
            opts.onProgress?.(sentBytes, src.size, { ...stages });
          } finally {
            if (log) log.fl.up--;
          }
        }
      };
      await Promise.all(Array.from({ length: conc }, worker));
      await hashChain;
      const plaintextSha256 = hasher.digest("hex");

      const manifest: ChunkManifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, chunkSizeBytes: this.chunkSize, chunks };
      const mct = await encryptManifest(key, manifest);
      throwIfAborted(signal);
      await renew();
      const mplaced = await this.blobs.put(mct, `${newId()}${BLOB_EXT}`, { uploadId, index: "m", sha256: await sha256Hex(mct), signal, stats });
      const version: ContentRef = {
        versionId: newId(),
        uploadId,
        sizeBytes: src.size,
        manifestRef: encodeManifestRef({ v: 1, f: FRAGMENT_FORMAT_VERSION, k: key.rawB64, at: mplaced }),
        chunkCount: count,
        plaintextSha256,
        // Rules v3: where the pieces are, per location (per-channel stats without manifests).
        pieces: piecesOf(manifest, mplaced, mct.byteLength),
      };
      throwIfAborted(signal);
      await renew();
      const tf = log ? nowMs() : 0;
      await this.blobs.finalize?.(uploadId);
      committed = true;
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
      log?.emit("commit", { dir: "up", x: uploadId, dur: ms(tf) });
      endLog(true);
      return { nodeId, uploadId, version, chunks: count, posts: stats.posts };
    } catch (e) {
      endLog(false, e);
      // Cancelled or failed before finalize: the store may drop what was sent (e2ee/plain: the server deletes).
      if (!committed) await this.blobs.abort?.(uploadId).catch(() => {});
      throw e;
    } finally {
      await this.d.arbiter.releaseLease(uploadId, deviceId);
    }
  }

  /** Manifests are immutable per version: small LRU (koncept §4.1, manifest layer on demand). */
  private readonly manifests = new Map<string, Promise<{ manifest: ChunkManifest; key: FileKey }>>();
  /** Manifest fetches from storage (diagnostics/tests). */
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
    const manifest = await decryptManifest(key, await this.blobs.get(loc.at));
    return { manifest, key };
  }

  /**
   * Download the current version of a file node into `sink`, verifying every
   * fragment's ciphertext hash and the whole-file plaintext SHA-256.
   */
  async download(nodeId: NodeId, sink: ByteSink, signalOrOpts?: AbortSignal | DownloadOptions): Promise<FileVersion> {
    const opts: DownloadOptions = signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});
    const signal = opts.signal;
    const node = this.store.getNode(nodeId);
    if (!node || node.kind !== "file" || !node.content) throw new Error("not a file");
    const v = node.content;
    const log = this.tlog;
    const x = v.uploadId;
    const t0 = nowMs();
    let total = 0;
    const conc = Math.min(this.downloadConc, Math.max(1, v.chunkCount));
    log?.emit("file_start", { dir: "down", x, size: v.sizeBytes, n: v.chunkCount, conc, mode: log.o.mode, ...log.nameFields(node.name) });
    try {
      const tm = log ? nowMs() : 0;
      const { manifest, key } = await this.loadManifest(v.manifestRef);
      log?.emit("manifest", { dir: "down", x, dur: ms(tm) });
      if (manifest.chunks.length !== v.chunkCount) throw new Error("manifest chunk count mismatch");
      const hasher = await createSHA256();
      hasher.init();
      opts.onProgress?.(0, v.sizeBytes);
      const ordered = [...manifest.chunks].sort((a, b) => a.index - b.index);
      // Parallel fetch (zlecenie 2026-10-13-transfer §3): up to `conc` fragments are fetched, checked and
      // decrypted at once; they are written strictly in order, so memory holds at most `conc` fragments and
      // the whole-file SHA-256 is fed in order. The first failure stops the others (internal abort).
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort);
      type Done = { pt: Uint8Array; ct: number; t: [number, number, number, number]; p: DiscordPlacement };
      const fetchOne = async (c: ChunkRef): Promise<Done> => {
        throwIfAborted(ac.signal);
        const p = c.placements?.[0] as DiscordPlacement | undefined;
        if (!p) throw new Error(`chunk ${c.index}: no placement`);
        if (log) log.fl.down++;
        try {
          const f0 = log ? nowMs() : 0;
          const ct = await this.blobs.get(p, ac.signal, { x, i: c.index });
          const f1 = log ? nowMs() : 0;
          if (c.ciphertextHash && (await sha256Hex(ct)) !== c.ciphertextHash) throw new Error(`chunk ${c.index}: ciphertext hash mismatch`);
          const f2 = log ? nowMs() : 0;
          const pt = await decryptFragment(key, ct);
          return { pt, ct: ct.byteLength, t: [f0, f1, f2, log ? nowMs() : 0], p };
        } finally {
          if (log) log.fl.down--;
        }
      };
      const inflight = new Map<number, Promise<Done>>();
      let launched = 0;
      // The first real failure (the others are then aborts caused by it) is what the caller sees.
      let firstErr: unknown = null;
      const launch = async () => {
        while (launched < ordered.length && inflight.size < conc) {
          const k = launched++;
          // Batch hint every 50 fragments (e2ee/plain: one link refresh call instead of 50).
          if (k % 50 === 0) await this.blobs.prefetch?.(ordered.slice(k, k + 50).map((y) => y.placements?.[0] as DiscordPlacement).filter(Boolean));
          const pr = fetchOne(ordered[k]!);
          pr.catch((e) => {
            if (!ac.signal.aborted) firstErr ??= e;
            ac.abort(); // stop the rest at once
          });
          inflight.set(k, pr);
        }
      };
      try {
        for (let i = 0; i < ordered.length; i++) {
          await launch();
          throwIfAborted(signal);
          const d = await inflight.get(i)!;
          inflight.delete(i);
          const w0 = log ? nowMs() : 0;
          const pb = d.pt.byteLength;
          hasher.update(d.pt);
          total += pb;
          // The sink may take the buffer (a stream transfers it): nothing reads d.pt after this.
          await sink.write(d.pt);
          const [f0, f1, f2, f3] = d.t;
          if (log) log.emit("frag", { dir: "down", x, i: ordered[i]!.index, b: d.ct, pb, get: ms(f0, f1), hash: ms(f1, f2), dec: ms(f2, f3), wait: ms(f3, w0), wr: ms(w0), dur: ms(f0), hook: d.p.locationId, ch: d.p.channelId ?? null, fl: log.fl.down });
          opts.onProgress?.(total, v.sizeBytes);
        }
      } catch (e) {
        ac.abort();
        await Promise.allSettled(inflight.values());
        throw signal?.aborted ? new AbortedError() : (firstErr ?? e);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (total !== v.sizeBytes) throw new Error(`size mismatch: ${total} != ${v.sizeBytes}`);
      const h = hasher.digest("hex");
      if (v.plaintextSha256 && h !== v.plaintextSha256) throw new Error("plaintext SHA-256 mismatch");
      log?.emit("file_end", { dir: "down", x, ok: true, size: v.sizeBytes, b: total, dur: ms(t0), mbps: mbps(total, ms(t0)) });
      return v;
    } catch (e) {
      log?.emit("file_end", { dir: "down", x, ok: false, size: v.sizeBytes, b: total, dur: ms(t0), mbps: mbps(total, ms(t0)), err: e instanceof Error && e.name === "AbortError" ? "aborted" : errText(e) });
      throw e;
    }
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
    return readVersionRange(this, node.content, start, end, cache, this.downloadConc);
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

function clampConc(n: number): number {
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n)));
}

/** MB/s (10^6 bytes per second, 2 decimals) of `bytes` in `durMs`. */
export function mbps(bytes: number, durMs: number): number {
  return durMs > 0 ? Math.round((bytes / 1e6 / (durMs / 1000)) * 100) / 100 : 0;
}

/** Piece locations of a version (rules v3 PieceLoc): fragments per placement location + the manifest. Sorted, unique. */
export function piecesOf(manifest: ChunkManifest, manifestAt: DiscordPlacement, manifestBytes: number): PieceLoc[] {
  const m = new Map<string, { n: number; bytes: number }>();
  const add = (loc: string, bytes: number) => {
    const x = m.get(loc) ?? { n: 0, bytes: 0 };
    x.n++;
    x.bytes += bytes;
    m.set(loc, x);
  };
  for (const c of manifest.chunks) {
    const p = c.placements?.[0] as DiscordPlacement | undefined;
    if (p?.locationId) add(p.locationId, c.ciphertextSizeBytes);
  }
  add(manifestAt.locationId, manifestBytes);
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([loc, x]) => ({ loc, n: x.n, bytes: x.bytes }));
}

/** Range read of one file version (shared by the client and, in plain mode, the server). */
export async function readVersionRange(
  c: { loadManifest(ref: string): Promise<{ manifest: ChunkManifest; key: FileKey }>; blobs: BlobStore },
  v: { versionId: string; sizeBytes: number; manifestRef: string },
  start: number,
  end: number,
  cache?: Map<string, Uint8Array>,
  concurrency = DEFAULT_DOWNLOAD_CONCURRENCY,
): Promise<{ data: Uint8Array; size: number; start: number; end: number }> {
  const size = v.sizeBytes;
  if (size === 0) return { data: new Uint8Array(0), size, start: 0, end: -1 };
  if (!(start >= 0 && start < size)) throw new RangeError(`range start ${start} outside 0..${size - 1}`);
  end = Math.min(end, size - 1);
  if (end < start) throw new RangeError("empty range");
  const { manifest, key } = await c.loadManifest(v.manifestRef);
  const cs = manifest.chunkSizeBytes;
  const out = new Uint8Array(end - start + 1);
  const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
  const first = Math.floor(start / cs);
  const last = Math.floor(end / cs);
  // The overlapping fragments, fetched with the same limit as a download (a long Range spans several).
  const one = async (i: number) => {
    const ch = chunks[i];
    if (!ch || ch.index !== i) throw new Error(`manifest has no chunk ${i}`);
    const ck = `${v.versionId}:${i}`;
    let pt = cache?.get(ck);
    if (!pt) {
      const ct = await c.blobs.get(ch.placements![0] as DiscordPlacement);
      if (ch.ciphertextHash && (await sha256Hex(ct)) !== ch.ciphertextHash) throw new Error(`chunk ${i}: ciphertext hash mismatch`);
      pt = await decryptFragment(key, ct);
      cache?.set(ck, pt);
    }
    const from = Math.max(start, i * cs) - i * cs;
    const to = Math.min(end, i * cs + pt.byteLength - 1) - i * cs;
    out.set(pt.subarray(from, to + 1), Math.max(start, i * cs) - start);
  };
  let next = first;
  const lane = async () => {
    while (next <= last) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, last - first + 1)) }, lane));
  return { data: out, size, start, end };
}
