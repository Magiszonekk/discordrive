// Client core shared by every mode: index (sync-core replica),
// operation log through the arbiter, per-file keys and fragment encryption in
// the discordrive format, manifests on demand, download/Range reads.
// WHERE the encrypted blobs go is a BlobStore chosen by the mode:
//   metadata only -> WebhookBlobStore (client.ts, the user's backends: Discord webhooks, …),
//   e2ee / plain  -> ServerBlobStore (server-blobs.ts, the instance posts).
//
// Upload protocol (rule 8, sync-core Sequencer comment):
//   renewLease(U) -> upload_begin [guard U], confirmed in the log ->
//   fragments (lease renewed while they go) -> manifest blob ->
//   blobs.finalize(U) -> group[upload_commit U, create(content)] [guard U] -> releaseLease(U).

import { fromBase64, toBase64 } from "@ddv4/processing";
import { DESCRIPTION_MAX_BYTES, descriptionNameOf, openDescription, type DescriptionRecord } from "./describe.js";
import { NetControl } from "./net.js";
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
  spaceOf,
} from "@ddv4/sync-core";
import type { ArbiterApi } from "./arbiter.js";
import { AbortedError, throwIfAborted, type BlobStore, type ExtraPlacement } from "./blob-store.js";
import { PREVIEW_KINDS, extraKey, matchExtras, openPreview, previewKeys, sealPreview, type PreviewImage, type PreviewKind } from "./previews.js";
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
import { isDiscordPlacement, type OtherPlacement, type Placement } from "./types.js";

/**
 * Upper bound of fragments in flight (up to 64 to saturate a ~600 Mb/s line). Each
 * upload fragment in flight holds ~2 × 10 MiB (ciphertext + request body), a download one ~2 × 10 MiB.
 */
export const MAX_CONCURRENCY = 64;
/**
 * Upper bound of the automatic value (both directions). Uploads are also bounded by 2 × channels (Discord's
 * per-channel limit makes more useless). Within the bounds the value is measured (net.ts AutoTuner).
 */
export const AUTO_CONCURRENCY_MAX = 32;
/** Starting value of the automatic download setting; also the Range-read default. */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
/** Memory a piece in flight holds (ciphertext + plaintext / request body of a 10 MiB fragment). */
export const BYTES_PER_PIECE = 20 * 1024 * 1024;

/** Plaintext fragment size; same as discordrive (10 MiB on the wire incl. 28 B of IV + tag). */
export const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024 - 28;
/**
 * Attachment file extension for everything we post (fragments, manifests,
 * snapshots). Measured 2026-10-09: Discord's CDN sends CORS headers only for
 * some content types, chosen by extension (.txt/.json/.webm/.png yes;
 * .bin/.dat/none no), so a browser can read only those. The bytes are the
 * same ciphertext as before (format unchanged); only the name differs.
 */
export const BLOB_EXT = ".txt";
export const MANIFEST_SCHEMA_VERSION = 1;
/** How much of a file's start the manifest carries (ChunkManifest.head). */
export const MANIFEST_HEAD_BYTES = 64 * 1024;
/** A version found without previews is looked at again after this long (another device may add them). */
export const PREVIEW_NONE_RECHECK_MS = 24 * 3600_000;
const MANIFEST_REF_PREFIX = "ddn1:";
const MANIFEST_REF2_PREFIX = "ddn2:";

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
  /** File root key, base64 (one key per file). */
  k: string;
  /** Where the encrypted manifest is. */
  at: Placement;
  /** Fragment format version. */
  f: number;
}

/** Longest manifestRef the sync core accepts (its `isRef`). */
export const MANIFEST_REF_MAX = 512;

/**
 * Discord: `ddn1:[1,f,k,webhookId,channelId,messageId,attachmentId]`, byte for byte the format every
 * existing device reads. Any other provider: `ddn2:[2,f,k,provider,locationId,[name,value,…]]` with the
 * placement's own fields sorted by name (the decoder needs nothing else to rebuild the placement).
 */
export function encodeManifestRef(loc: ManifestLocator): string {
  const at = loc.at;
  if (isDiscordPlacement(at)) return `${MANIFEST_REF_PREFIX}${JSON.stringify([loc.v, loc.f, loc.k, at.locationId, at.channelId, at.messageId, at.attachmentId])}`;
  const fields = Object.keys(at)
    .filter((n) => n !== "provider" && n !== "locationId")
    .sort()
    .flatMap((n) => [n, String(at[n])]);
  const ref = `${MANIFEST_REF2_PREFIX}${JSON.stringify([2, loc.f, loc.k, at.provider, at.locationId, fields])}`;
  if (ref.length > MANIFEST_REF_MAX) throw new Error(`manifestRef too long (${ref.length} > ${MANIFEST_REF_MAX})`);
  return ref;
}

export function decodeManifestRef(ref: string): ManifestLocator {
  if (ref.startsWith(MANIFEST_REF2_PREFIX)) {
    const a = JSON.parse(ref.slice(MANIFEST_REF2_PREFIX.length)) as unknown[];
    const fields = a?.[5];
    if (!Array.isArray(a) || a[0] !== 2 || a.length !== 6 || typeof a[1] !== "number" || typeof a[2] !== "string" || typeof a[3] !== "string" || typeof a[4] !== "string" || !Array.isArray(fields) || fields.length % 2 || !fields.every((x) => typeof x === "string")) {
      throw new Error("bad manifestRef");
    }
    const at: OtherPlacement = { provider: a[3], locationId: a[4] };
    for (let i = 0; i < fields.length; i += 2) if (fields[i] !== "provider" && fields[i] !== "locationId") at[fields[i] as string] = fields[i + 1] as string;
    return { v: 1, f: a[1], k: a[2], at };
  }
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
   * Upload fragments in flight at once (a store may still gate per channel). Default: automatic (measured,
   * at most 2 × the channels the store spreads over and AUTO_CONCURRENCY_MAX).
   */
  concurrency?: number;
  /** Download fragments in flight at once (fetched in parallel, written in order). Default: automatic. */
  downloadConcurrency?: number;
  /** Memory the pieces in flight may hold (bytes); bounds the automatic value. Default 640 MiB (32 pieces). */
  memoryBudget?: number;
  /** Renew the upload lease at least this often (ms). */
  leaseRenewMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Q10: called once per device that reached INVALID_OP_WARN_AFTER invalid ops. */
  onInvalidOps?: (a: InvalidOpAlert) => void;
  /** Network state (tests: virtual clock); default: a fresh one. */
  net?: NetControl;
  /** Unfinished transfers (resume after a reload); none = no resume. */
  resume?: ResumeStore;
}

/** Fragments of an upload per stage right now (live view: encrypting vs sending). */
export interface UploadStages {
  /** Reading + encrypting + hashing. */
  enc: number;
  /** Waiting for the limiter or on the wire. */
  net: number;
}

/**
 * Where unfinished transfers are remembered on this device (resume after
 * a reload). Browser: IndexedDB of this origin. Values are plain JSON; an upload's entry holds the file
 * key of the unfinished version (the device already holds the account key the same way).
 */
export interface ResumeStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix`. */
  entries(prefix: string): Promise<[string, unknown][]>;
  delPrefix(prefix: string): Promise<void>;
}

/**
 * Journal of an unfinished upload: the header under `up:<resumeKey>`, and one small entry per stored
 * fragment under `upf:<resumeKey>:<index>` (written as each fragment lands: O(1) per fragment, also for a
 * 100 GB file with 10 000 fragments).
 */
export interface UploadJournal {
  v: 1;
  uploadId: string;
  nodeId: string;
  parentId: string;
  name: string;
  size: number;
  chunk: number;
  key: string;
  at: number;
}
/** One stored fragment of an unfinished upload, and the SHA-256 of its plaintext (a changed file is not mixed in). */
export interface UploadJournalFrag {
  c: ChunkRef;
  ph: string;
}
export const resumeKeys = (resumeKey: string) => ({ head: `up:${resumeKey}`, frags: `upf:${resumeKey}:` });

export interface UploadOptions {
  /** Plaintext bytes whose fragments are stored so far (called after each fragment and on stage changes). */
  onProgress?: (doneBytes: number, totalBytes: number, stages?: UploadStages) => void;
  /**
   * Resume key (the UI: name + size + modification time + folder). With `resume` set on the client, an
   * upload with the same key continues the unfinished one: fragments already stored are not sent again.
   */
  resumeKey?: string;
  /** Cancel: stops the fragment in flight; the store drops what was sent (e2ee/plain). */
  signal?: AbortSignal;
  /**
   * Thumbnail / preview of the file (made by the caller from the plaintext while the fragments go out).
   * Encrypted with the file key and stored with the manifest; awaited only when the manifest is posted.
   * A rejection or a picture that does not fit the limits is skipped: the file is uploaded without it.
   */
  previews?: Promise<PreviewImage[] | null>;
  /** When the content was made (File.lastModified, a file's mtime, a photo's date), ms; kept in the manifest. */
  takenAt?: number;
  /**
   * A new version of this existing file instead of a new file (overwrite): committed as new_content_version
   * on the version the caller saw (a concurrent change becomes a conflict copy, rule 7).
   */
  replace?: { nodeId: NodeId; baseVersionId: string | null };
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Plaintext bytes written to the sink so far. */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  /**
   * Resume: the sink already holds fragments [0, from) of this version;
   * `hash` is the whole-file SHA-256 state after them (from `onWritten`). Only the rest is fetched.
   */
  resume?: { versionId: string; from: number; hash: Uint8Array };
  /** After each fragment written: the next index and the hash state so far (to store a resume point). */
  onWritten?: (p: { versionId: string; next: number; hash: () => Uint8Array }) => void;
}

export interface UploadResult {
  nodeId: NodeId;
  uploadId: string;
  version: ContentRef;
  chunks: number;
  posts: number;
  /** Fragments taken over from an unfinished upload (not sent again). */
  resumed: number;
}

export class DriveClient {
  readonly replica: Replica;
  /** Log-derived facts for client policies (Q4 last purge, Q5 non-NFC names, Q10 invalid ops). */
  readonly observer = new LogObserver();
  readonly blobs: BlobStore;
  protected readonly chunkSize: number;
  /** Fixed upload concurrency (option / setting); null = automatic (measured). */
  private concurrencyOpt: number | null;
  /** Fixed download concurrency; null = automatic (measured). */
  private downloadOpt: number | null;
  private readonly memoryBudget: number;
  protected readonly leaseRenewMs: number;
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  /** Transfer log (Settings → Diagnostics); null = off. */
  tlog: TransferLog | null = null;
  /**
   * Network state shared by uploads and downloads: no-network
   * gate, a window of pieces in flight per direction that shrinks on network errors and grows back,
   * the stuck-connection guard for downloads, "save data".
   */
  readonly net: NetControl;

  constructor(protected readonly d: DriveClientOptions) {
    this.replica = new Replica({ device: d.device, store: d.store, newOpId: newId, now: d.now });
    this.blobs = d.blobs;
    this.chunkSize = d.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.concurrencyOpt = d.concurrency ? clampConc(d.concurrency) : null;
    this.downloadOpt = d.downloadConcurrency ? clampConc(d.downloadConcurrency) : null;
    this.memoryBudget = d.memoryBudget ?? 32 * BYTES_PER_PIECE;
    this.leaseRenewMs = d.leaseRenewMs ?? 60_000;
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.net = d.net ?? new NetControl();
    this.blobs.net = this.net;
    this.net.emitTo = (ev, f) => this.tlog?.emit(ev, f);
    this.net.tune.up.onTarget = () => this.syncWindows();
    this.net.tune.down.onTarget = () => this.syncWindows();
    this.syncWindows();
  }

  /** Bounds of the automatic value: memory, AUTO_CONCURRENCY_MAX, and for uploads 2 × channels (at least 3). */
  autoCap(dir: "up" | "down"): number {
    const mem = Math.max(2, Math.floor(this.memoryBudget / BYTES_PER_PIECE));
    const lanes = dir === "up" ? Math.max(3, 2 * (this.blobs.lanes?.() ?? 1)) : AUTO_CONCURRENCY_MAX;
    return Math.max(1, Math.min(AUTO_CONCURRENCY_MAX, mem, lanes));
  }

  /** Window maxima follow the settings (fixed or automatic); "save data" / metered: at most 2 per direction. */
  syncWindows(): void {
    this.net.tune.up.setCap(this.autoCap("up"));
    this.net.tune.down.setCap(this.autoCap("down"));
    const lean = this.net.metered();
    this.net.win.up.setMax(lean ? Math.min(2, this.uploadConcurrency) : this.uploadConcurrency);
    this.net.win.down.setMax(lean ? Math.min(2, this.downloadConcurrency) : this.downloadConcurrency);
  }

  /** The automatic value of this direction is in charge (no fixed setting, no save data). */
  private tuning(dir: "up" | "down"): boolean {
    return (dir === "up" ? this.concurrencyOpt : this.downloadOpt) === null && !this.net.metered();
  }

  /** Settings → "Save data" (on top of what the browser reports as metered). */
  setSaveData(on: boolean): void {
    this.net.saveData = on;
    this.syncWindows();
  }

  /** Plaintext bytes per fragment (uploads, the speed test). */
  get fragmentSize(): number {
    return this.chunkSize;
  }

  get store(): IndexStore {
    return this.replica.store;
  }

  /** Turn transfer logs on (a TransferLog) or off (null) for this client and its blob store. */
  setTransferLog(l: TransferLog | null): void {
    this.tlog = l;
    this.blobs.log = l;
  }

  /** Fragments in flight for uploads now: the setting, else the automatic (measured) value. */
  get uploadConcurrency(): number {
    return this.concurrencyOpt ?? Math.min(this.net.tune.up.target, this.autoCap("up"));
  }

  /** Fragments in flight for downloads now: the setting, else the automatic (measured) value. */
  get downloadConcurrency(): number {
    return this.downloadOpt ?? Math.min(this.net.tune.down.target, this.autoCap("down"));
  }

  /** Which directions run on the automatic value. */
  get autoConcurrency(): { upload: boolean; download: boolean } {
    return { upload: this.concurrencyOpt === null, download: this.downloadOpt === null };
  }

  /** Settings → Network → pieces in flight (null / 0 = automatic). */
  setConcurrency(o: { upload?: number | null; download?: number | null }): void {
    if (o.upload !== undefined) this.concurrencyOpt = o.upload ? clampConc(o.upload) : null;
    if (o.download !== undefined) this.downloadOpt = o.download ? clampConc(o.download) : null;
    this.syncWindows();
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
  async fetchPlacement(p: Placement): Promise<Uint8Array> {
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
    // The pictures are awaited only when the manifest goes out: a failure before that is not "unhandled".
    opts.previews?.catch(() => {});
    throwIfAborted(signal);
    const deviceId = this.d.device.id;
    // Resume: the same upload ID, file key and node ID as the unfinished
    // upload, if it is still open in the index and its lease can be taken again; otherwise a fresh start.
    const rs = this.d.resume;
    const rk = opts.resumeKey && rs ? resumeKeys(opts.resumeKey) : null;
    let jr: UploadJournal | null = null;
    const prevFrags = new Map<number, UploadJournalFrag>();
    const forget = async () => {
      if (!rk) return;
      await rs!.del(rk.head).catch(() => {});
      await rs!.delPrefix(rk.frags).catch(() => {});
    };
    if (rk) {
      const j = (await rs!.get(rk.head).catch(() => null)) as UploadJournal | null;
      const u = j?.v === 1 ? this.store.getUpload(j.uploadId) : undefined;
      if (j && u?.status === "open" && j.size === src.size && j.chunk === this.chunkSize && j.parentId === parentId && j.name === nfc && (await this.d.arbiter.renewLease(j.uploadId, deviceId))) {
        jr = j;
        for (const [k, v] of await rs!.entries(rk.frags).catch(() => [] as [string, unknown][])) {
          const i = Number(k.slice(rk.frags.length));
          const f = v as UploadJournalFrag;
          if (Number.isInteger(i) && f?.c && typeof f.ph === "string") prevFrags.set(i, f);
        }
      } else if (j) await forget();
    }
    const uploadId = jr?.uploadId ?? newId();
    const nodeId = jr?.nodeId ?? newId();
    const stats = { posts: 0 };
    let resumed = 0;
    const log = this.tlog;
    const t0 = nowMs();
    const nFrags = Math.max(1, Math.ceil(src.size / this.chunkSize));
    this.syncWindows();
    const win = this.net.win.up;
    const conc = Math.min(win.max, nFrags);
    const auto = this.tuning("up");
    // Workers: as many as the value may grow to; the window gates how many run (the automatic value moves it).
    const workers = Math.min(nFrags, auto ? Math.max(win.max, this.autoCap("up")) : win.max);
    log?.emit("file_start", { dir: "up", x: uploadId, size: src.size, n: nFrags, chunk: this.chunkSize, conc, ...(auto ? { auto: true } : {}), lanes: this.blobs.lanes?.() ?? null, win: win.limit, ...(this.net.metered() ? { lean: true } : {}), mode: log.o.mode, ...(log.o.build ? { build: log.o.build } : {}), ...log.nameFields(nfc) });
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
      if (!jr) await this.commitOp({ type: "upload_begin", uploadId }, "upload_begin");

      const key = jr ? await importFileKey(jr.key) : await newFileKey();
      const count = Math.max(1, Math.ceil(src.size / this.chunkSize));
      const chunks: ChunkRef[] = new Array(count);
      const journal = !!rk;
      if (rk && !jr) await rs!.put(rk.head, { v: 1, uploadId, nodeId, parentId, name: nfc, size: src.size, chunk: this.chunkSize, key: key.rawB64, at: Date.now() } satisfies UploadJournal).catch(() => {});
      if (jr) log?.emit("resume", { dir: "up", x: uploadId, have: prevFrags.size, n: count });
      const hasher = await createSHA256();
      hasher.init();
      // The whole-file plaintext hash must be fed in order. Reads run in parallel (each fragment's own),
      // the hash takes them in index order as soon as each is read (not after its post, as before), so a
      // fragment's plaintext is dropped right after it is encrypted and hashed: memory follows the
      // fragments in flight, not the slowest post (30–60 in flight).
      let hashChain: Promise<unknown> = Promise.resolve();
      let head: Uint8Array | null = null;
      const readInOrder = (i: number): Promise<{ data: Uint8Array; rd: number; ph: number }> => {
        const r0 = nowMs();
        const read = src.read(i * this.chunkSize, this.chunkSize).then((data) => {
          if (i === 0) head = data.slice(0, MANIFEST_HEAD_BYTES);
          return { data, rd: ms(r0) };
        });
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
      // The first failure stops the other workers from taking new fragments (before, they went on sending
      // the rest of the file after the upload had already failed).
      let failed = false;
      const worker = async () => {
        for (;;) {
          // The adaptive window (weak link: fewer pieces in flight) gates taking the next fragment.
          const free = await win.acquire(signal);
          const i = failed ? count : next++;
          if (i >= count) return free();
          try {
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
            // Only the size and the timings outlive encryption: the plaintext is dropped right after it (a
            // 10 MiB buffer per fragment in flight would otherwise stay until the post returns).
            let data: Uint8Array | null = rd.data;
            const pb = data.byteLength;
            const rdPh = rd.ph;
            if (log) f1 = nowMs();
            // Resume: the same plaintext as in the unfinished upload → its stored fragment is taken over.
            const ph = journal ? await sha256Hex(data) : "";
            const prev = prevFrags.get(i);
            if (prev && prev.ph === ph) {
              chunks[i] = prev.c;
              resumed++;
              stages.enc--;
              sentBytes += pb;
              opts.onProgress?.(sentBytes, src.size, { ...stages });
              continue;
            }
            const ct = await encryptFragment(key, data);
            data = null;
            if (log) f2 = nowMs();
            const blobId = newId();
            const hash = await sha256Hex(ct);
            if (log) f3 = nowMs();
            stages.enc--;
            stages.net++;
            opts.onProgress?.(sentBytes, src.size, { ...stages });
            // Automatic value: the tuner sees every piece on the wire (bytes and time).
            const tk = auto ? this.net.tune.up.begin() : null;
            let placed: Placement;
            try {
              placed = await this.blobs.put(ct, `${blobId}${BLOB_EXT}`, { uploadId, index: i, sha256: hash, signal, stats });
            } catch (e) {
              if (tk) this.net.tune.up.drop(tk);
              throw e;
            }
            stages.net--;
            if (tk && this.tuning("up")) this.net.tune.up.end(tk, ct.byteLength, next < count);
            else if (tk) this.net.tune.up.drop(tk);
            chunks[i] = { index: i, blobId, ciphertextSizeBytes: ct.byteLength, ciphertextHash: hash, placements: [placed] };
            if (rk) void rs!.put(rk.frags + i, { c: chunks[i]!, ph } satisfies UploadJournalFrag).catch(() => {});
            const f4 = log ? nowMs() : 0;
            sentBytes += pb;
            // rd = from the worker taking the fragment to it being read and hashed in order; ph = the hash step.
            if (log) log.emit("frag", { dir: "up", x: uploadId, i, pb, b: ct.byteLength, rd: ms(f0, f1), enc: ms(f1, f2), hash: ms(f2, f3), put: ms(f3, f4), ph: rdPh, dur: ms(f0), hook: placed.locationId, ch: placed.channelId ?? null, fl: log.fl.up });
            opts.onProgress?.(sentBytes, src.size, { ...stages });
          } finally {
            if (log) log.fl.up--;
          }
          } finally {
            free();
          }
        }
      };
      // All workers end before the upload returns or throws (Promise.all would reject at the first failure
      // while the others still post: fragments of a failed upload landing after it, and in the journal).
      // A cancel does not wait for the posts in flight (the user asked to stop now).
      let firstErr: unknown = null;
      const done = Promise.all(Array.from({ length: workers }, () => worker().catch((e) => ((failed = true), (firstErr ??= e)))));
      const aborted = signal ? new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true }))) : null;
      await (aborted ? Promise.race([done, aborted]) : done);
      failed = true;
      throwIfAborted(signal);
      if (firstErr) throw firstErr;
      await hashChain;
      const plaintextSha256 = hasher.digest("hex");

      const taken = opts.takenAt !== undefined && Number.isFinite(opts.takenAt) && opts.takenAt > 0 ? Math.floor(opts.takenAt) : undefined;
      const manifest: ChunkManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        chunkSizeBytes: this.chunkSize,
        chunks,
        ...(taken ? { takenAt: taken } : {}),
        ...(head && (head as Uint8Array).byteLength ? { head: toBase64(head as Uint8Array) } : {}),
      };
      const mct = await encryptManifest(key, manifest);
      throwIfAborted(signal);
      // Previews go with the manifest (same message): a failed or missing one never fails the upload.
      const extras = opts.previews ? await this.sealPreviews(key.rawB64, opts.previews) : [];
      await renew();
      const mctx = { uploadId, index: "m" as const, sha256: await sha256Hex(mct), signal, stats };
      const withX = extras.length && this.blobs.putWithExtras ? await this.blobs.putWithExtras(mct, `${newId()}${BLOB_EXT}`, extras, mctx) : null;
      const mplaced = withX ? withX.placement : await this.blobs.put(mct, `${newId()}${BLOB_EXT}`, mctx);
      const madePreviews = withX ? matchExtras(await previewKeys(key.rawB64), withX.extras) : null;
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
            opts.replace
              ? { type: "new_content_version", nodeId: opts.replace.nodeId, baseVersionId: opts.replace.baseVersionId, content: version, nameHint: nfc, ...this.spaceField(opts.replace.nodeId) }
              : { type: "create", kind: "file", nodeId, parentId, name: nfc, content: version, ...this.spaceField(parentId) },
          ],
        },
        "upload_commit+create",
      );
      log?.emit("commit", { dir: "up", x: uploadId, dur: ms(tf) });
      // This device knows where the previews it just stored are (no look at the message later).
      if (madePreviews) {
        this.previewIndex.set(version.manifestRef, Promise.resolve(madePreviews));
        (this.store as unknown as { setPreviewInfo?(r: string, v: string, at: number): void }).setPreviewInfo?.(version.manifestRef, JSON.stringify(madePreviews), this.now());
      }
      await forget();
      endLog(true);
      return { nodeId: opts.replace?.nodeId ?? nodeId, uploadId, version, chunks: count, posts: stats.posts, resumed };
    } catch (e) {
      endLog(false, e);
      // Cancelled or failed before finalize: the store may drop what was sent (e2ee/plain: the server deletes).
      // A cancel by the user forgets the journal; a failure (network, tab closing) keeps it for a resume.
      const cancelled = e instanceof Error && e.name === "AbortError";
      if (cancelled) await forget();
      if (!committed && (cancelled || !rk)) await this.blobs.abort?.(uploadId).catch(() => {});
      throw e;
    } finally {
      await this.d.arbiter.releaseLease(uploadId, deviceId);
    }
  }

  /** Pictures from the caller, checked and encrypted for storage next to the manifest (failures dropped). */
  private async sealPreviews(fileKey: string, p: Promise<PreviewImage[] | null>): Promise<{ filename: string; data: Uint8Array }[]> {
    const imgs = await p.catch(() => null);
    if (!imgs?.length) return [];
    const keys = await previewKeys(fileKey);
    const out: { filename: string; data: Uint8Array }[] = [];
    for (const k of PREVIEW_KINDS) {
      const img = imgs.find((x) => x.kind === k);
      if (!img) continue;
      try {
        const b = await sealPreview(keys, img);
        out.push({ filename: `${b.name}${BLOB_EXT}`, data: b.data });
      } catch {
        /* not within the limits: left out */
      }
    }
    return out;
  }

  /** Preview attachments found per manifest (null = none; kept for this session, a store re-reads on a miss). */
  private readonly previewIndex = new Map<string, Promise<Partial<Record<PreviewKind, ExtraPlacement>>>>();

  /**
   * Where the pictures of a version are (a look at its manifest's message), {} when it has none. Kept in
   * the local index where it has a table for it (a "none" is looked at again after PREVIEW_NONE_RECHECK_MS:
   * another device may add them).
   */
  async previewsOf(manifestRef: string, signal?: AbortSignal): Promise<Partial<Record<PreviewKind, ExtraPlacement>>> {
    let p = this.previewIndex.get(manifestRef);
    if (!p) {
      const db = this.store as unknown as { previewInfo?(r: string): { v: string; at: number } | undefined; setPreviewInfo?(r: string, v: string, at: number): void };
      p = (async () => {
        const known = db.previewInfo?.(manifestRef);
        const none = known && (known.v === "{}" || known.v === "-");
        if (known && (!none || this.now() - known.at < PREVIEW_NONE_RECHECK_MS)) return none ? {} : (JSON.parse(known.v) as Partial<Record<PreviewKind, ExtraPlacement>>);
        const loc = decodeManifestRef(manifestRef);
        if (!this.blobs.extrasOf) return {};
        const extras = await this.blobs.extrasOf(loc.at, signal);
        const found = matchExtras(await previewKeys(loc.k), extras);
        // "-" (tried, none could be made) stays "-" while there are still none.
        db.setPreviewInfo?.(manifestRef, Object.keys(found).length || known?.v !== "-" ? JSON.stringify(found) : "-", this.now());
        return found;
      })();
      this.previewIndex.set(manifestRef, p);
      p.catch(() => this.previewIndex.delete(manifestRef));
      while (this.previewIndex.size > 5000) this.previewIndex.delete(this.previewIndex.keys().next().value!);
    }
    return p;
  }

  /**
   * The AI description stored with a version (describe.ts), null when it has none. Uses the same look at
   * the manifest's message as the previews when it is fresh (no extra read).
   */
  async readDescription(manifestRef: string, signal?: AbortSignal): Promise<DescriptionRecord | null> {
    const dn = await descriptionNameOf(manifestRef);
    if (!dn || !this.blobs.extrasOf) return null;
    const loc = decodeManifestRef(manifestRef);
    const ex = (await this.blobs.extrasOf(loc.at, signal)).find((x) => extraKey(x.name) === extraKey(dn.name));
    if (!ex) return null;
    if (ex.size > DESCRIPTION_MAX_BYTES) return null;
    return openDescription(dn.k, await this.blobs.get(ex.placement, signal));
  }

  /** The first bytes of a version kept in its manifest (null: an older upload without them). */
  async headOf(manifestRef: string): Promise<Uint8Array | null> {
    const h = (await this.loadManifest(manifestRef)).manifest.head;
    return typeof h === "string" && h ? fromBase64(h) : null;
  }

  /** When the content of a version was made, if its uploader stored it (manifest takenAt). */
  async takenAt(manifestRef: string): Promise<number | null> {
    const t = (await this.loadManifest(manifestRef)).manifest.takenAt;
    return typeof t === "number" && t > 0 ? t : null;
  }

  /** One picture of a version, decrypted; null when the version has none of that kind. */
  async readPreview(manifestRef: string, kind: PreviewKind, signal?: AbortSignal): Promise<PreviewImage | null> {
    const at = (await this.previewsOf(manifestRef, signal))[kind];
    if (!at) return null;
    const loc = decodeManifestRef(manifestRef);
    return openPreview(await previewKeys(loc.k), kind, await this.blobs.get(at.placement, signal));
  }

  /**
   * Add pictures to an existing version (made later from its content). Kinds it already has are kept;
   * returns which kinds were added. Nothing in the tree or the log changes.
   */
  async addPreviews(manifestRef: string, imgs: PreviewImage[], uploadId?: string): Promise<PreviewKind[]> {
    if (!this.blobs.addExtras) throw new Error("this storage cannot keep previews");
    const loc = decodeManifestRef(manifestRef);
    this.previewIndex.delete(manifestRef);
    (this.store as unknown as { setPreviewInfo?(r: string, v: string, at: number): void }).setPreviewInfo?.(manifestRef, "{}", 0);
    const have = await this.previewsOf(manifestRef);
    const keys = await previewKeys(loc.k);
    const add: { filename: string; data: Uint8Array }[] = [];
    const kinds: PreviewKind[] = [];
    for (const img of imgs) {
      if (have[img.kind] || kinds.includes(img.kind)) continue;
      const b = await sealPreview(keys, img);
      add.push({ filename: `${b.name}${BLOB_EXT}`, data: b.data });
      kinds.push(img.kind);
    }
    if (!add.length) return [];
    const extras = await this.blobs.addExtras(loc.at, add, { uploadId });
    const found = matchExtras(keys, extras);
    this.previewIndex.set(manifestRef, Promise.resolve(found));
    (this.store as unknown as { setPreviewInfo?(r: string, v: string, at: number): void }).setPreviewInfo?.(manifestRef, JSON.stringify(found), this.now());
    return kinds;
  }

  /** Manifests are immutable per version: small LRU (manifest layer on demand). */
  private readonly manifests = new Map<string, Promise<{ manifest: ChunkManifest; key: FileKey }>>();
  /** Manifest fetches from storage (diagnostics/tests). */
  manifestLoads = 0;

  /** Load and decrypt the manifest of a version (manifests on demand; cached). */
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
    this.syncWindows();
    const win = this.net.win.down;
    const conc = Math.min(win.max, Math.max(1, v.chunkCount));
    const auto = this.tuning("down");
    log?.emit("file_start", { dir: "down", x, size: v.sizeBytes, n: v.chunkCount, conc, ...(auto ? { auto: true } : {}), win: win.limit, lanes: this.net.laneCount, ...(this.net.metered() ? { lean: true } : {}), mode: log.o.mode, ...(log.o.build ? { build: log.o.build } : {}), ...log.nameFields(node.name) });
    try {
      const tm = log ? nowMs() : 0;
      const { manifest, key } = await this.loadManifest(v.manifestRef);
      log?.emit("manifest", { dir: "down", x, dur: ms(tm) });
      if (manifest.chunks.length !== v.chunkCount) throw new Error("manifest chunk count mismatch");
      const hasher = await createSHA256();
      hasher.init();
      const all = [...manifest.chunks].sort((a, b) => a.index - b.index);
      // Resume: skip what the sink already has (same version only; the hash continues from its state).
      const from = opts.resume && opts.resume.versionId === v.versionId && opts.resume.from > 0 && opts.resume.from <= all.length ? opts.resume.from : 0;
      if (from) {
        hasher.load(opts.resume!.hash);
        total = Math.min(v.sizeBytes, from * manifest.chunkSizeBytes);
        log?.emit("resume", { dir: "down", x, have: from, n: all.length });
      }
      const ordered = all.slice(from);
      opts.onProgress?.(total, v.sizeBytes);
      // Parallel fetch: up to `conc` fragments are fetched, checked and
      // decrypted at once; they are written strictly in order, so memory holds at most `conc` fragments and
      // the whole-file SHA-256 is fed in order. The first failure stops the others (internal abort).
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort);
      type Done = { pt: Uint8Array; ct: number; t: [number, number, number, number]; p: Placement };
      const fetchOne = async (c: ChunkRef): Promise<Done> => {
        throwIfAborted(ac.signal);
        const p = c.placements?.[0] as Placement | undefined;
        if (!p) throw new Error(`chunk ${c.index}: no placement`);
        if (log) log.fl.down++;
        try {
          const f0 = log ? nowMs() : 0;
          // Automatic value: the tuner sees every piece read (bytes and time).
          const tk = auto ? this.net.tune.down.begin() : null;
          let ct: Uint8Array;
          try {
            ct = await this.blobs.get(p, ac.signal, { x, i: c.index });
          } catch (e) {
            if (tk) this.net.tune.down.drop(tk);
            throw e;
          }
          // `more`: the slots, not the end of the file or the write buffer, were the limit.
          if (tk && this.tuning("down")) this.net.tune.down.end(tk, ct.byteLength, launched < ordered.length && launched - writing < ahead);
          else if (tk) this.net.tune.down.drop(tk);
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
      // Fetches still on the network: the concurrency limit counts only these. Finished fragments that wait
      // for an earlier one to be written (strict order) no longer block new fetches — before, one slow
      // fragment at the head held all `conc` slots and the download ran in waves (owner's log 2026-10-15:
      // ~25 s with 0 fragments finishing, then ~30 at once; 14 MB/s on a line that does 110). Memory is
      // bounded separately: at most `ahead` fragments past the one being written.
      let fetching = 0;
      // Read-ahead past the fragment being written (memory): follows the value, which may change during the download.
      let ahead = Math.max(conc * 2, 16);
      let writing = 0;
      // A finished fetch frees a slot at once (even while the writer still waits for the head fragment).
      const nudge = () => {
        if (!ac.signal.aborted) void launch().catch(() => {});
      };
      let launched = 0;
      // The first real failure (the others are then aborts caused by it) is what the caller sees.
      let firstErr: unknown = null;
      let launching = false;
      let again = false;
      const launch = async (): Promise<void> => {
        if (launching) {
          again = true; // a slot freed while a launch was in progress: run once more after it
          return;
        }
        launching = true;
        again = false;
        try {
        // The window (weak link: fewer at once; the automatic value) is read every time: it changes during the download.
        while (launched < ordered.length && fetching < Math.min(win.max, win.limit) && launched - writing < (ahead = Math.max(win.max * 2, 16))) {
          const k = launched++;
          // Links ahead: every 25 fragments, a hint for the next 75 (metadata only: their links are fetched in
          // the background while these download; e2ee/plain: one refresh call for the ones not cached yet).
          // Only a hint: a failure here (no network) is retried per fragment inside get().
          if (k % 25 === 0) await this.blobs.prefetch?.(ordered.slice(k, k + 75).map((y) => y.placements?.[0] as Placement).filter(Boolean), { x, first: k + from }).catch(() => {});
          fetching++;
          const pr = fetchOne(ordered[k]!);
          pr.then(
            () => {
              fetching--;
              nudge();
            },
            (e) => {
              fetching--;
              if (!ac.signal.aborted) firstErr ??= e;
              ac.abort(); // stop the rest at once
              nudge();
            },
          );
          inflight.set(k, pr);
        }
        } finally {
          launching = false;
        }
        if (again && !ac.signal.aborted) return launch();
      };
      try {
        for (let i = 0; i < ordered.length; i++) {
          await launch();
          throwIfAborted(signal);
          const d = await inflight.get(i)!;
          inflight.delete(i);
          writing = i + 1;
          nudge();
          const w0 = log ? nowMs() : 0;
          const pb = d.pt.byteLength;
          hasher.update(d.pt);
          total += pb;
          // The sink may take the buffer (a stream transfers it): nothing reads d.pt after this.
          await sink.write(d.pt);
          const [f0, f1, f2, f3] = d.t;
          if (log) log.emit("frag", { dir: "down", x, i: ordered[i]!.index, b: d.ct, pb, get: ms(f0, f1), hash: ms(f1, f2), dec: ms(f2, f3), wait: ms(f3, w0), wr: ms(w0), dur: ms(f0), hook: d.p.locationId, ch: d.p.channelId ?? null, fl: log.fl.down });
          opts.onWritten?.({ versionId: v.versionId, next: from + i + 1, hash: () => hasher.save() });
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
   * version, fetching only the fragments that overlap (video
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
    return readVersionRange(this, node.content, start, end, cache, this.downloadConcurrency);
  }

  /**
   * `space: "gallery"` for an op on something in the Gallery (rules 4: if the album is purged meanwhile, the
   * file goes to the Gallery's root, not to „Recovered”); nothing for the Drive (the op stays rules 3).
   */
  spaceField(id: NodeId): { space?: "gallery" } {
    return this.store.getNode(id) && spaceOf(this.store, id) === "gallery" ? { space: "gallery" } : {};
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
export function piecesOf(manifest: ChunkManifest, manifestAt: Placement, manifestBytes: number): PieceLoc[] {
  const m = new Map<string, { n: number; bytes: number }>();
  const add = (loc: string, bytes: number) => {
    const x = m.get(loc) ?? { n: 0, bytes: 0 };
    x.n++;
    x.bytes += bytes;
    m.set(loc, x);
  };
  for (const c of manifest.chunks) {
    const p = c.placements?.[0] as Placement | undefined;
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
      const ct = await c.blobs.get(ch.placements![0] as Placement);
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
