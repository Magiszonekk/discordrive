// Snapshots on Discord and the pointer message (koncept §6.2, §3.5).
//
// Objects (all sealed with the account subkey "snapshot", gzip before
// encryption, each its own attachment posted through the paced client):
//   segment  - the ENCRYPTED log entries (as the server stores them, op
//              payloads stay sealed with the op subkey) for seq from..to, plus
//              a link to the previous segment. Segments form one chain from
//              seq 1, across bases, so any point in the retained window can be
//              rebuilt (retention: plan, not done yet).
//   base     - the decrypted tree (sync-core IndexSnapshot) at headSeq, split
//              into parts no bigger than a fragment. Only devices on an
//              unmetered link write bases (§6.2).
//   pointer  - ONE fixed message, edited (PATCH, attachment replaced) after
//              every snapshot: the current base and the last segment. A
//              client never replaces a pointer that covers more of the log.
// Rescue kit (§3.5) = account ID + account key + one webhook URL + pointer
// message ID: enough to rebuild the tree with no server at all.
//
// Policy (§6.2): segment after 1 min of log silence, at the latest 5 min after
// the first unsnapshotted entry, only when there are changes; base when the
// segments since the last base exceed 20 % of its size or it is 7 days old.

import { fromBase64, toBase64 } from "@ddv4/processing";
import { deletableUploads, applyEntries, initIndex, loadSnapshot, takeSnapshot, type IndexSnapshot, type IndexStore, MemoryIndexStore } from "@ddv4/sync-core";
import { seal, unseal, type AccountKey } from "./account-key.js";
import type { DiscordPlacement, WebhookRef, WebhookTransport } from "./types.js";
import { OpCodec, type EncryptedEntry, type EncryptedLogApi } from "./op-crypto.js";

export const SNAPSHOT_CONTAINER_VERSION = 1;
export const SEGMENT_QUIET_MS = 60_000;
export const SEGMENT_MAX_DELAY_MS = 5 * 60_000;
export const BASE_SEGMENT_RATIO = 0.2;
export const BASE_MAX_AGE_MS = 7 * 24 * 3600_000;

/** Where an object is: enough for anyone holding a vault webhook of that channel. */
export interface ObjRef {
  webhookId: string;
  messageId: string;
  attachmentId: string;
  /** Sealed size (bytes on Discord). */
  size: number;
}

export interface SegmentRef extends ObjRef {
  fromSeq: number;
  toSeq: number;
}

export interface BaseRef {
  headSeq: number;
  parts: ObjRef[];
  /** Sum of sealed part sizes (20 % rule). */
  size: number;
  createdAt: number;
  /** Segment that ends at headSeq (written in the same run); start of the prune walk. */
  segmentAtBase?: SegmentRef | null;
}

export interface Pointer {
  v: 1;
  /** Highest log seq covered by base + segment chain. */
  toSeq: number;
  base: BaseRef | null;
  lastSegment: SegmentRef | null;
  /** Bytes of segments written after `base` (20 % rule). */
  segmentBytesSinceBase: number;
  writtenAt: number;
  /** Older bases still kept (retention, §6.2), newest first. Optional: absent = none. */
  history?: BaseRef[];
  /** Segments with toSeq <= this were deleted from Discord (prune bookkeeping). */
  prunedUpTo?: number;
}

export interface PointerLocation {
  webhookId: string;
  messageId: string;
}

interface SegmentBody {
  v: 1;
  fromSeq: number;
  toSeq: number;
  prev: SegmentRef | null;
  entries: EncryptedEntry[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (d: Uint8Array) => pipe(d, new CompressionStream("gzip"));
export const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream("gzip"));

const AAD = {
  pointer: (acct: string) => `ddn-pointer-v1|${acct}`,
  segment: (acct: string, from: number, to: number) => `ddn-segment-v1|${acct}|${from}|${to}`,
  base: (acct: string, headSeq: number, i: number, n: number) => `ddn-base-v1|${acct}|${headSeq}|${i}|${n}`,
};

async function sealObj(key: AccountKey, value: unknown, aad: string): Promise<Uint8Array> {
  return seal(await key.subkey("snapshot"), await gzip(enc.encode(JSON.stringify(value))), aad);
}
async function unsealObj<T>(key: AccountKey, data: Uint8Array, aad: string, what: string): Promise<T> {
  return JSON.parse(dec.decode(await gunzip(await unseal(await key.subkey("snapshot"), data, aad, what)))) as T;
}

/** Discord access the snapshot code needs (MetadataClient provides it; restore builds a bare one). */
export interface BlobIO {
  post(data: Uint8Array, filename: string): Promise<DiscordPlacement>;
  /** Delete an object's message (retention). 404 = already gone, not an error. */
  remove(ref: ObjRef): Promise<void>;
  fetch(p: DiscordPlacement): Promise<Uint8Array>;
  hook(id: string): WebhookRef;
  transport: WebhookTransport;
  /** Max bytes per attachment (base parts). */
  partSize: number;
}

const toPlacement = (r: ObjRef): DiscordPlacement => ({
  provider: "discord-webhook",
  locationId: r.webhookId,
  channelId: "",
  messageId: r.messageId,
  attachmentId: r.attachmentId,
});
const toRef = (p: DiscordPlacement, size: number): ObjRef => ({ webhookId: p.locationId, messageId: p.messageId, attachmentId: p.attachmentId, size });

export function emptyPointer(): Pointer {
  return { v: 1, toSeq: 0, base: null, lastSegment: null, segmentBytesSinceBase: 0, writtenAt: 0 };
}

// --- pointer message

export async function createPointerMessage(io: BlobIO, key: AccountKey, accountId: string, hook: WebhookRef): Promise<PointerLocation> {
  const r = await io.transport.postFile(hook, await sealObj(key, emptyPointer(), AAD.pointer(accountId)), "ddn-pointer.bin");
  return { webhookId: hook.id, messageId: r.messageId };
}

export async function readPointer(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation): Promise<Pointer> {
  const atts = await io.transport.getAttachments(io.hook(loc.webhookId), loc.messageId);
  if (atts.length !== 1) throw new Error("pointer message: expected one attachment");
  const p = await unsealObj<Pointer>(key, await io.transport.fetchCdn(atts[0]!.url), AAD.pointer(accountId), "pointer");
  if (p.v !== 1) throw new Error("unsupported pointer version");
  return p;
}

/**
 * Replace the pointer unless the current one already covers at least as much (§6.2).
 * mode "same_coverage": bookkeeping update (retention) allowed only while the
 * pointer still has exactly the coverage and base we computed it from.
 */
export async function writePointer(
  io: BlobIO,
  key: AccountKey,
  accountId: string,
  loc: PointerLocation,
  next: Pointer,
  mode: "advance" | "same_coverage" = "advance",
): Promise<"written" | "kept_newer"> {
  const cur = await readPointer(io, key, accountId, loc);
  if (mode === "same_coverage") {
    if (cur.toSeq !== next.toSeq || (cur.base?.headSeq ?? -1) !== (next.base?.headSeq ?? -1)) return "kept_newer";
  } else {
    // Never go back: more log covered wins; at equal coverage a newer base wins.
    const newerBase = (next.base?.headSeq ?? -1) > (cur.base?.headSeq ?? -1);
    if (cur.toSeq > next.toSeq || (cur.toSeq === next.toSeq && !newerBase)) return "kept_newer";
  }
  await io.transport.editMessageFile(io.hook(loc.webhookId), loc.messageId, await sealObj(key, next, AAD.pointer(accountId)), "ddn-pointer.bin");
  return "written";
}

// --- policy

export interface SnapshotClock {
  /** Server time of the newest log entry. */
  lastEntryAt: number;
  /** Server time of the oldest entry not covered by the pointer. */
  firstPendingAt: number;
}

export type SnapshotDecision = "none" | "segment" | "base";

export function decideSnapshot(
  now: number,
  headSeq: number,
  pointer: Pointer,
  clock: SnapshotClock,
  opts: { unmetered: boolean; force?: boolean },
): SnapshotDecision {
  if (headSeq <= pointer.toSeq) return "none";
  const due =
    opts.force || now - clock.lastEntryAt >= SEGMENT_QUIET_MS || now - clock.firstPendingAt >= SEGMENT_MAX_DELAY_MS;
  if (!due) return "none";
  if (opts.unmetered) {
    const b = pointer.base;
    if (!b) return "base";
    if (pointer.segmentBytesSinceBase > BASE_SEGMENT_RATIO * b.size) return "base";
    if (now - b.createdAt >= BASE_MAX_AGE_MS) return "base";
  }
  return "segment";
}

// --- writing

export interface SnapshotDeps {
  io: BlobIO;
  key: AccountKey;
  accountId: string;
  pointer: PointerLocation;
  /** Server log (encrypted entries). */
  log: EncryptedLogApi;
  /** The device's tree (for bases); must be at least at the head being snapshotted. */
  store: IndexStore;
  now: () => number;
}

export interface SnapshotResult {
  kind: "segment" | "base" | "none";
  pointer: Pointer;
  written: "written" | "kept_newer" | "nothing";
  posts: number;
}

/**
 * Write a segment (always, if there are new entries) and, when asked, a base
 * at the store's headSeq; then update the pointer. Calls on Discord: 1 POST per
 * segment + base parts + GET/PATCH of the pointer.
 */
export async function writeSnapshot(d: SnapshotDeps, kind: "segment" | "base"): Promise<SnapshotResult> {
  const cur = await readPointer(d.io, d.key, d.accountId, d.pointer);
  const headSeq = d.store.getMeta().headSeq;
  let posts = 0;
  let next: Pointer = { ...cur };

  if (headSeq > cur.toSeq) {
    const entries: EncryptedEntry[] = [];
    for (;;) {
      const batch = await d.log.read(cur.toSeq + entries.length, Math.min(1000, headSeq - cur.toSeq - entries.length));
      if (batch.length === 0) break;
      entries.push(...batch);
      if (cur.toSeq + entries.length >= headSeq) break;
    }
    if (entries.length !== headSeq - cur.toSeq) throw new Error("server log shorter than local index");
    const body: SegmentBody = { v: 1, fromSeq: cur.toSeq + 1, toSeq: headSeq, prev: cur.lastSegment, entries };
    const sealed = await sealObj(d.key, body, AAD.segment(d.accountId, body.fromSeq, body.toSeq));
    const p = await d.io.post(sealed, "ddn-segment.bin");
    posts++;
    const seg: SegmentRef = { ...toRef(p, sealed.byteLength), fromSeq: body.fromSeq, toSeq: body.toSeq };
    next = { ...next, toSeq: headSeq, lastSegment: seg, segmentBytesSinceBase: next.segmentBytesSinceBase + sealed.byteLength };
  }

  if (kind === "base" && (next.base?.headSeq ?? -1) < headSeq) {
    const snap = takeSnapshot(d.store);
    const whole = await gzip(enc.encode(JSON.stringify(snap)));
    const partLen = Math.max(1, d.io.partSize - 64);
    const n = Math.max(1, Math.ceil(whole.byteLength / partLen));
    const parts: ObjRef[] = [];
    let size = 0;
    for (let i = 0; i < n; i++) {
      const sealed = await seal(await d.key.subkey("snapshot"), whole.subarray(i * partLen, (i + 1) * partLen), AAD.base(d.accountId, headSeq, i, n));
      const p = await d.io.post(sealed, "ddn-base.bin");
      posts++;
      parts.push(toRef(p, sealed.byteLength));
      size += sealed.byteLength;
    }
    const history = next.base ? [next.base, ...(next.history ?? [])] : (next.history ?? []);
    next = { ...next, base: { headSeq, parts, size, createdAt: d.now(), segmentAtBase: next.lastSegment }, history, segmentBytesSinceBase: 0 };
  }

  if (posts === 0) return { kind: "none", pointer: cur, written: "nothing", posts };
  next.writtenAt = d.now();
  const written = await writePointer(d.io, d.key, d.accountId, d.pointer, next);
  return { kind: next.base && next.base !== cur.base ? "base" : "segment", pointer: next, written, posts };
}

// --- retention (§6.2): 7 daily + 4 weekly bases, segments from the oldest kept base

export const DAILY_BASES = 7;
export const WEEKLY_BASES = 4;
const DAY = 24 * 3600_000;

/**
 * Which bases to keep (§6.2: 7 daily + 4 weekly, ~30 days back): the current
 * base, the newest base of each of the 7 most recent days that have one, and
 * the oldest base of each of the 4 most recent weeks BEFORE that daily window
 * (UTC, weeks from Monday). Days and weeks count only those that HAVE bases,
 * so a device closed for a month does not lose its whole history on the next run.
 */
export function selectRetained(bases: BaseRef[]): { keep: BaseRef[]; drop: BaseRef[] } {
  const sorted = [...bases].sort((a, b) => b.headSeq - a.headSeq);
  const keep = new Set<BaseRef>();
  if (sorted[0]) keep.add(sorted[0]);
  const dayOf = (b: BaseRef) => Math.floor(b.createdAt / DAY);
  const weekOf = (b: BaseRef) => Math.floor((b.createdAt / DAY + 3) / 7); // 1970-01-01 was a Thursday
  const days = new Set<number>();
  for (const b of sorted) {
    if (days.has(dayOf(b))) continue;
    if (days.size >= DAILY_BASES) break;
    days.add(dayOf(b));
    keep.add(b);
  }
  const oldestDay = days.size ? Math.min(...days) : Infinity;
  // Weekly: the OLDEST base of each of the 4 most recent weeks before the daily
  // window. The oldest kept base sets how far back a restore can go (segments
  // after it are all kept), so the oldest-of-week choice gives the ~30 days of §6.2.
  const weekly = new Map<number, BaseRef>();
  for (const b of sorted) {
    if (dayOf(b) >= oldestDay) continue;
    const w = weekOf(b);
    if (!weekly.has(w) && weekly.size >= WEEKLY_BASES) break;
    weekly.set(w, b); // sorted newest first, so the last write per week is its oldest base
  }
  for (const b of weekly.values()) keep.add(b);
  return { keep: sorted.filter((b) => keep.has(b)), drop: sorted.filter((b) => !keep.has(b)) };
}

/**
 * §6.2: fragments may be deleted from Discord only after 30 days AND when no
 * kept base still points at them. A base points at a released upload iff it
 * was taken before the release, so: released at seq <= oldest kept base.
 */
export function deletableUploadsWithRetention(store: IndexStore, pointer: Pointer, nowServerMs: number): string[] {
  const bases = [pointer.base, ...(pointer.history ?? [])].filter((b): b is BaseRef => !!b);
  const oldestBaseSeq = bases.length ? Math.min(...bases.map((b) => b.headSeq)) : Infinity;
  return deletableUploads(store, nowServerMs).filter((id) => {
    const u = store.getUpload(id)!;
    return u.status === "aborted" || (u.ended !== null && u.ended.seq <= oldestBaseSeq);
  });
}

export interface PruneResult {
  written: "written" | "kept_newer" | "nothing";
  basesDropped: number;
  partsDeleted: number;
  segmentsDeleted: number;
}

/**
 * Apply retention. The pointer is written first (so it never references a
 * deleted message), then the messages are deleted. Segments older than the
 * oldest kept base are found by walking back from that base's segmentAtBase,
 * stopping at prunedUpTo, so each run touches only what is new to delete.
 */
export async function pruneSnapshots(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation, now: () => number): Promise<PruneResult> {
  const cur = await readPointer(io, key, accountId, loc);
  const all = [cur.base, ...(cur.history ?? [])].filter((b): b is BaseRef => !!b);
  const { keep, drop } = selectRetained(all);
  const oldestKept = keep.at(-1) ?? null;
  const pruneTo = oldestKept?.headSeq ?? 0;
  const segDrop: SegmentRef[] = [];
  let ref = oldestKept?.segmentAtBase ?? null;
  const done = cur.prunedUpTo ?? 0;
  while (ref && ref.toSeq > done && ref.toSeq <= pruneTo) {
    segDrop.push(ref);
    const body = await unsealObj<SegmentBody>(key, await io.fetch(toPlacement(ref)), AAD.segment(accountId, ref.fromSeq, ref.toSeq), "segment");
    ref = body.prev;
  }
  if (drop.length === 0 && segDrop.length === 0) return { written: "nothing", basesDropped: 0, partsDeleted: 0, segmentsDeleted: 0 };
  const next: Pointer = { ...cur, history: keep.filter((b) => b !== cur.base), prunedUpTo: Math.max(done, segDrop.length ? pruneTo : done), writtenAt: now() };
  const written = await writePointer(io, key, accountId, loc, next, "same_coverage");
  if (written !== "written") return { written, basesDropped: 0, partsDeleted: 0, segmentsDeleted: 0 };
  let partsDeleted = 0;
  for (const b of drop) for (const p of b.parts) (await io.remove(p), partsDeleted++);
  for (const sgm of segDrop) await io.remove(sgm);
  return { written, basesDropped: drop.length, partsDeleted, segmentsDeleted: segDrop.length };
}

// --- restore (§3.5): no server needed

export interface RestoreResult {
  store: IndexStore;
  pointer: Pointer;
  /** Encrypted entries after the base: what a new server's log tail is reseeded with. */
  tail: EncryptedEntry[];
  baseHeadSeq: number;
}

export async function loadBase(io: BlobIO, key: AccountKey, accountId: string, b: BaseRef): Promise<IndexSnapshot> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < b.parts.length; i++) {
    const raw = await io.fetch(toPlacement(b.parts[i]!));
    chunks.push(await unseal(await key.subkey("snapshot"), raw, AAD.base(accountId, b.headSeq, i, b.parts.length), "base part"));
  }
  const whole = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) (whole.set(c, o), (o += c.byteLength));
  const snap = JSON.parse(dec.decode(await gunzip(whole))) as IndexSnapshot;
  if (snap.meta.headSeq !== b.headSeq) throw new Error("base headSeq mismatch");
  return snap;
}

/**
 * Rebuild the tree from Discord alone. `atSeq`: point-in-time restore (§6.2,
 * „przywrócić stan z dowolnego momentu”): uses the newest kept base at or
 * before it and replays the log only up to atSeq.
 */
export async function restoreFromDiscord(
  io: BlobIO,
  key: AccountKey,
  accountId: string,
  loc: PointerLocation,
  store: IndexStore = new MemoryIndexStore(),
  atSeq?: number,
): Promise<RestoreResult> {
  const pointer = await readPointer(io, key, accountId, loc);
  const target = atSeq ?? pointer.toSeq;
  if (target > pointer.toSeq || target < 0) throw new Error(`cannot restore seq ${target}: snapshots cover up to ${pointer.toSeq}`);
  const bases = [pointer.base, ...(pointer.history ?? [])].filter((b): b is BaseRef => !!b).sort((a, b) => b.headSeq - a.headSeq);
  const base = bases.find((b) => b.headSeq <= target) ?? null;
  if (!base && (pointer.prunedUpTo ?? 0) > 0) throw new Error(`seq ${target} is older than the retained snapshots`);
  const baseHead = base?.headSeq ?? 0;
  if (base) loadSnapshot(await loadBase(io, key, accountId, base), store);
  else initIndex(store);

  // Walk the chain back to the base.
  const segs: SegmentBody[] = [];
  let ref = pointer.lastSegment;
  let expectTo = pointer.toSeq;
  while (ref && ref.toSeq > baseHead) {
    if (ref.toSeq !== expectTo) throw new Error(`segment chain gap: expected to=${expectTo}, got ${ref.toSeq}`);
    const body = await unsealObj<SegmentBody>(key, await io.fetch(toPlacement(ref)), AAD.segment(accountId, ref.fromSeq, ref.toSeq), "segment");
    if (body.fromSeq !== ref.fromSeq || body.toSeq !== ref.toSeq || body.entries.length !== body.toSeq - body.fromSeq + 1) {
      throw new Error("segment does not match its reference");
    }
    segs.unshift(body);
    expectTo = ref.fromSeq - 1;
    ref = body.prev;
  }
  if (expectTo > baseHead) throw new Error(`segment chain does not reach the base (stops at ${expectTo}, base ${baseHead})`);

  const tail = segs.flatMap((s) => s.entries).filter((e) => e.seq > baseHead && e.seq <= target);
  for (let i = 0; i < tail.length; i++) if (tail[i]!.seq !== baseHead + i + 1) throw new Error("tail not contiguous");
  const codec = new OpCodec(key, accountId);
  applyEntries(store, await Promise.all(tail.map((e) => codec.decrypt(e))));
  if (store.getMeta().headSeq !== target) throw new Error("restored head does not match the target");
  return { store, pointer, tail, baseHeadSeq: baseHead };
}

// --- rescue kit (§3.5)

export interface RescueKit {
  v: 1;
  accountId: string;
  /** Account key, base64. */
  key: string;
  /** One webhook URL (the pointer's). */
  webhookUrl: string;
  pointerMessageId: string;
}

/** Compact text form for printing/QR: "ddn-kit1:" + base64url(JSON). Secret. */
export function encodeRescueKit(k: RescueKit): string {
  return "ddn-kit1:" + toBase64(enc.encode(JSON.stringify(k))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRescueKit(s: string): RescueKit {
  const t = s.trim();
  if (!t.startsWith("ddn-kit1:")) throw new Error("not a rescue kit");
  let b = t.slice(9).replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const k = JSON.parse(dec.decode(fromBase64(b))) as RescueKit;
  if (k.v !== 1 || !k.accountId || !k.key || !k.webhookUrl || !k.pointerMessageId) throw new Error("bad rescue kit");
  return k;
}

// --- BlobIO adapters

/** BlobIO over a MetadataClient (paced posts, retried fetches). */
export function clientBlobIO(
  c: { postBlob(d: Uint8Array, f: string): Promise<DiscordPlacement>; fetchPlacement(p: DiscordPlacement): Promise<Uint8Array>; webhook(id: string): WebhookRef },
  transport: WebhookTransport,
  partSize = 10 * 1024 * 1024,
): BlobIO {
  return {
    post: (d, f) => c.postBlob(d, f),
    fetch: (p) => c.fetchPlacement(p),
    remove: (r) => removeQuietly(transport, c.webhook(r.webhookId), r.messageId),
    hook: (id) => c.webhook(id),
    transport,
    partSize,
  };
}

async function removeQuietly(t: WebhookTransport, hook: WebhookRef, messageId: string): Promise<void> {
  try {
    await t.deleteMessage(hook, messageId);
  } catch (e) {
    if (!/404|Unknown Message/.test(String((e as Error)?.message ?? e))) throw e;
  }
}

/** Read-only BlobIO from a rescue kit: one webhook, no server, no index. */
export function rescueBlobIO(transport: WebhookTransport, hook: WebhookRef): BlobIO {
  const get = (id: string) => {
    if (id !== hook.id) throw new Error(`object behind webhook ${id}, rescue kit has ${hook.id}`);
    return hook;
  };
  return {
    post: () => Promise.reject(new Error("read-only")),
    remove: () => Promise.reject(new Error("read-only")),
    fetch: async (p) => {
      const atts = await transport.getAttachments(get(p.locationId), p.messageId);
      const a = atts.find((x) => x.id === p.attachmentId);
      if (!a) throw new Error("attachment missing");
      return transport.fetchCdn(a.url);
    },
    hook: get,
    transport,
    partSize: 0,
  };
}

// --- scheduler (§6.2, §3.6: only while a client is open)

export interface SchedulerDeps extends SnapshotDeps {
  /** Device writes snapshots at all (main device / main tab). */
  isPrimary: () => boolean;
  /** Unmetered link: may write bases (§6.2); phones only write segments. */
  unmetered: () => boolean;
  /** Server time of a log entry by seq (from the local log tail / index). */
  serverTimeOf: (seq: number) => number | undefined;
}

/**
 * Call tick() periodically (e.g. every 15 s) and after every pull. It writes
 * at most one snapshot per call, then applies retention after a new base.
 */
export class SnapshotScheduler {
  private pointer: Pointer | null = null;
  private running = false;
  readonly history: SnapshotResult[] = [];
  lastPrune: PruneResult | null = null;

  constructor(private readonly d: SchedulerDeps) {}

  async tick(force = false): Promise<SnapshotResult | null> {
    if (this.running || !this.d.isPrimary()) return null;
    this.running = true;
    try {
      this.pointer ??= await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
      const head = this.d.store.getMeta().headSeq;
      const lastAt = this.d.serverTimeOf(head) ?? this.d.now();
      const firstAt = this.d.serverTimeOf(this.pointer.toSeq + 1) ?? lastAt;
      const decision = decideSnapshot(this.d.now(), head, this.pointer, { lastEntryAt: lastAt, firstPendingAt: firstAt }, { unmetered: this.d.unmetered(), force });
      if (decision === "none") return null;
      const r = await writeSnapshot(this.d, decision);
      this.history.push(r);
      // Re-read after a refused write (another device was ahead), else trust what we wrote.
      this.pointer = r.written === "written" ? r.pointer : await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
      if (r.kind === "base" && r.written === "written") {
        this.lastPrune = await pruneSnapshots(this.d.io, this.d.key, this.d.accountId, this.d.pointer, this.d.now);
        this.pointer = await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
      }
      return r;
    } finally {
      this.running = false;
    }
  }
}
