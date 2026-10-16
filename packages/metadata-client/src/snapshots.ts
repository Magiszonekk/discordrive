// Snapshots on the storage backends and the pointer.
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
//              unmetered link write bases.
//   pointer  - ONE fixed slot (Discord: a message edited in place, PATCH with
//              the attachment replaced) rewritten after every snapshot: the
//              current base and the last segment. A client never replaces a
//              pointer that covers more of the log. It also carries a copy of
//              the account's backend list from the vault (`backends`, with the
//              vault revision it came from): segments, bases and manifests are
//              spread over every backend, so a device that has nothing but the
//              rescue kit learns the others here.
// Rescue kit = account ID + account key + the pointer's backend + slot (plus,
// in kit 3, the backend list when the kit was made): enough to rebuild the tree
// and read every file with no server at all.
//
// Policy: segment after 1 min of log silence, at the latest 5 min after
// the first unsnapshotted entry, only when there are changes; base when the
// segments since the last base exceed 20 % of its size or it is 7 days old.

import { fromBase64, toBase64 } from "@ddv4/processing";
import { deletableUploads, applyEntries, initIndex, loadSnapshot, takeSnapshot, type IndexSnapshot, type IndexStore, MemoryIndexStore } from "@ddv4/sync-core";
import { accountKeyFromB64, seal, unseal, type AccountKey } from "./account-key.js";
import { DISCORD_PROVIDER, isDiscordPlacement, type OtherPlacement, type Placement, type WebhookRef, type WebhookTransport } from "./types.js";
import { BackendRegistry, DiscordWebhooks, discordSlot, type BackendSlot, type BlobBackend } from "./backends.js";
import type { LinkAheadOptions } from "./link-ahead.js";
import { parseWebhookUrl } from "./discord-transport.js";
import { OpCodec, type EncryptedEntry, type EncryptedLogApi } from "./op-crypto.js";

export const SNAPSHOT_CONTAINER_VERSION = 1;
export const SEGMENT_QUIET_MS = 60_000;
export const SEGMENT_MAX_DELAY_MS = 5 * 60_000;
export const BASE_SEGMENT_RATIO = 0.2;
export const BASE_MAX_AGE_MS = 7 * 24 * 3600_000;

/**
 * Where an object is. Discord: webhook ID + message + attachment (enough for anyone holding a vault
 * webhook of that channel). Another backend: `webhookId` is its ID and `at` the whole placement.
 */
export interface ObjRef {
  webhookId: string;
  messageId: string;
  attachmentId: string;
  /** Sealed size (bytes stored). */
  size: number;
  /** Placement on a backend other than Discord. */
  at?: OtherPlacement;
}

/**
 * A backend as the pointer and the rescue kit carry it: what a device with nothing but the account key
 * needs to read from it. Discord: the webhook URL (secret). Other kinds: their credentials (`secret`) and
 * settings (`meta`). Only ever stored sealed (pointer) or in the rescue kit.
 */
export interface BackendDescriptor {
  kind: string;
  id: string;
  /** Discord: the webhook URL. */
  url?: string;
  channelId?: string;
  secret?: Record<string, string>;
  meta?: Record<string, string>;
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
  /** Older bases still kept (retention), newest first. Optional: absent = none. */
  history?: BaseRef[];
  /** Segments with toSeq <= this were deleted from Discord (prune bookkeeping). */
  prunedUpTo?: number;
  /**
   * Copy of the account's backend list from the vault (optional: absent in pointers written before it
   * existed or by an older client; the next write by a current client puts it back).
   */
  backends?: BackendDescriptor[];
  /** Vault revision the `backends` copy came from (a newer copy is never replaced by an older one). */
  vaultRevision?: number;
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

/** Storage access the snapshot code needs (MetadataClient provides it; restore builds a bare one). */
export interface BlobIO {
  post(data: Uint8Array, filename: string): Promise<Placement>;
  /** Delete an object (retention). Already gone = not an error. */
  remove(ref: ObjRef): Promise<void>;
  fetch(p: Placement): Promise<Uint8Array>;
  /** The pointer slot of a backend. */
  slot(backendId: string): BackendSlot;
  /** A rescue IO learns the account's other backends from the pointer (read-only IOs only). */
  learn?(list: BackendDescriptor[]): void;
  /** Max bytes per attachment (base parts). */
  partSize: number;
}

export const toPlacement = (r: ObjRef): Placement =>
  r.at ?? {
    provider: DISCORD_PROVIDER,
    locationId: r.webhookId,
    channelId: "",
    messageId: r.messageId,
    attachmentId: r.attachmentId,
  };
const toRef = (p: Placement, size: number): ObjRef =>
  isDiscordPlacement(p) ? { webhookId: p.locationId, messageId: p.messageId, attachmentId: p.attachmentId, size } : { webhookId: p.locationId, messageId: "", attachmentId: "", size, at: { ...(p as OtherPlacement) } };

/** Same backends (kind, ID, credentials) in the same order: no pointer rewrite needed. */
export function sameBackends(a: BackendDescriptor[] | undefined, b: BackendDescriptor[] | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function emptyPointer(): Pointer {
  return { v: 1, toSeq: 0, base: null, lastSegment: null, segmentBytesSinceBase: 0, writtenAt: 0 };
}

// --- pointer message

/** A new pointer slot on backend `at` (Discord: a message through the webhook). `init`: the backend list. */
export async function createPointerMessage(
  io: BlobIO,
  key: AccountKey,
  accountId: string,
  at: { id: string },
  init?: { list: BackendDescriptor[]; revision: number } | null,
): Promise<PointerLocation> {
  const p: Pointer = init ? { ...emptyPointer(), backends: init.list, vaultRevision: init.revision } : emptyPointer();
  const slot = await io.slot(at.id).create(await sealObj(key, p, AAD.pointer(accountId)), "ddn-pointer.txt");
  return { webhookId: at.id, messageId: slot };
}

export async function readPointer(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation): Promise<Pointer> {
  const p = await unsealObj<Pointer>(key, await io.slot(loc.webhookId).read(loc.messageId), AAD.pointer(accountId), "pointer");
  if (p.v !== 1) throw new Error("unsupported pointer version");
  return p;
}

/**
 * Replace the pointer unless the current one already covers at least as much.
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
  // The backend list: a copy from a newer vault revision is never replaced by an older one (another device
  // saw the vault later), nor dropped by a writer that has none.
  if ((cur.vaultRevision ?? -1) > (next.vaultRevision ?? -1) || (cur.backends && !next.backends)) next = { ...next, backends: cur.backends, vaultRevision: cur.vaultRevision };
  if (mode === "same_coverage") {
    if (cur.toSeq !== next.toSeq || (cur.base?.headSeq ?? -1) !== (next.base?.headSeq ?? -1)) return "kept_newer";
  } else {
    // Never go back: more log covered wins; at equal coverage a newer base wins.
    const newerBase = (next.base?.headSeq ?? -1) > (cur.base?.headSeq ?? -1);
    if (cur.toSeq > next.toSeq || (cur.toSeq === next.toSeq && !newerBase)) return "kept_newer";
  }
  await io.slot(loc.webhookId).write(loc.messageId, await sealObj(key, next, AAD.pointer(accountId)), "ddn-pointer.txt");
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
  /**
   * The account's backend list from the vault and its revision (null = unknown now). Every pointer
   * write carries it; metadata only (the e2ee/plain instance keeps its webhooks itself).
   */
  backends?: () => { list: BackendDescriptor[]; revision: number } | null;
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
    const p = await d.io.post(sealed, "ddn-segment.txt");
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
      const p = await d.io.post(sealed, "ddn-base.txt");
      posts++;
      parts.push(toRef(p, sealed.byteLength));
      size += sealed.byteLength;
    }
    const history = next.base ? [next.base, ...(next.history ?? [])] : (next.history ?? []);
    next = { ...next, base: { headSeq, parts, size, createdAt: d.now(), segmentAtBase: next.lastSegment }, history, segmentBytesSinceBase: 0 };
  }

  if (posts === 0) return { kind: "none", pointer: cur, written: "nothing", posts };
  next.writtenAt = d.now();
  const mine = d.backends?.();
  if (mine) ((next.backends = mine.list), (next.vaultRevision = mine.revision));
  const written = await writePointer(d.io, d.key, d.accountId, d.pointer, next);
  return { kind: next.base && next.base !== cur.base ? "base" : "segment", pointer: next, written, posts };
}

// --- retention: 7 daily + 4 weekly bases, segments from the oldest kept base

export const DAILY_BASES = 7;
export const WEEKLY_BASES = 4;
const DAY = 24 * 3600_000;

/**
 * Which bases to keep (7 daily + 4 weekly; ~30 days back): the current
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
  // after it are all kept), so the oldest-of-week choice gives the ~30 days of retention.
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
 * Fragments may be deleted from Discord only after 30 days AND when no
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
export async function pruneSnapshots(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation, now: () => number, backends?: SnapshotDeps["backends"]): Promise<PruneResult> {
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
  const mine = backends?.();
  const next: Pointer = { ...cur, history: keep.filter((b) => b !== cur.base), prunedUpTo: Math.max(done, segDrop.length ? pruneTo : done), writtenAt: now(), ...(mine ? { backends: mine.list, vaultRevision: mine.revision } : {}) };
  const written = await writePointer(io, key, accountId, loc, next, "same_coverage");
  if (written !== "written") return { written, basesDropped: 0, partsDeleted: 0, segmentsDeleted: 0 };
  let partsDeleted = 0;
  for (const b of drop) for (const p of b.parts) (await io.remove(p), partsDeleted++);
  for (const sgm of segDrop) await io.remove(sgm);
  return { written, basesDropped: drop.length, partsDeleted, segmentsDeleted: segDrop.length };
}

// --- moving the chain to another channel (the channel holding it is critical)

/** Every object the current pointer can reach: kept segments (walked back to prunedUpTo), base parts, segmentAtBase. */
export async function chainObjects(io: BlobIO, key: AccountKey, accountId: string, p: Pointer): Promise<{ segments: { ref: SegmentRef; body: SegmentBody }[]; parts: ObjRef[] }> {
  const segments: { ref: SegmentRef; body: SegmentBody }[] = [];
  let ref = p.lastSegment;
  const done = p.prunedUpTo ?? 0;
  while (ref && ref.toSeq > done) {
    const body = await unsealObj<SegmentBody>(key, await io.fetch(toPlacement(ref)), AAD.segment(accountId, ref.fromSeq, ref.toSeq), "segment");
    segments.push({ ref, body });
    ref = body.prev;
  }
  const bases = [p.base, ...(p.history ?? [])].filter((b): b is BaseRef => !!b);
  return { segments, parts: bases.flatMap((b) => b.parts) };
}

/**
 * Copy the whole snapshot chain to one webhook (`post` posts there) and write a new pointer message
 * there: kept history preserved (point-in-time restore keeps working). Segments are re-sealed
 * (their body names the previous segment's message), base parts are copied byte for byte (their AAD
 * does not name a location). Returns the new pointer location and the old objects, which the caller
 * deletes once the vault points at the new pointer (the old rescue kit then stops working).
 */
export async function rehomeChain(
  io: BlobIO,
  key: AccountKey,
  accountId: string,
  oldLoc: PointerLocation,
  hook: { id: string },
  post: (data: Uint8Array, filename: string) => Promise<Placement>,
  now: () => number,
  /** The account's backend list for the new pointer (metadata only). */
  list?: { list: BackendDescriptor[]; revision: number } | null,
): Promise<{ loc: PointerLocation; pointer: Pointer; old: ObjRef[] }> {
  const p = await readPointer(io, key, accountId, oldLoc);
  const { segments } = await chainObjects(io, key, accountId, p);
  const k = (r: ObjRef) => `${r.webhookId}/${r.messageId || JSON.stringify(r.at ?? null)}`;
  const seg = new Map<string, SegmentRef>();
  const old: ObjRef[] = [];
  for (const { ref, body } of [...segments].reverse()) {
    const prev = body.prev ? (seg.get(k(body.prev)) ?? body.prev) : null;
    const sealed = await sealObj(key, { ...body, prev }, AAD.segment(accountId, body.fromSeq, body.toSeq));
    const np = await post(sealed, "ddn-segment.txt");
    seg.set(k(ref), { ...toRef(np, sealed.byteLength), fromSeq: ref.fromSeq, toSeq: ref.toSeq });
    old.push(ref);
  }
  const parts = new Map<string, ObjRef>();
  const base = async (b: BaseRef | null): Promise<BaseRef | null> => {
    if (!b) return null;
    const out: ObjRef[] = [];
    for (const part of b.parts) {
      let np = parts.get(k(part));
      if (!np) {
        const raw = await io.fetch(toPlacement(part));
        np = toRef(await post(raw, "ddn-base.txt"), raw.byteLength);
        parts.set(k(part), np);
        old.push(part);
      }
      out.push(np);
    }
    return { ...b, parts: out, segmentAtBase: b.segmentAtBase ? (seg.get(k(b.segmentAtBase)) ?? b.segmentAtBase) : b.segmentAtBase };
  };
  const next: Pointer = {
    ...p,
    base: await base(p.base),
    history: p.history ? await Promise.all(p.history.map((h) => base(h).then((x) => x!))) : p.history,
    lastSegment: p.lastSegment ? (seg.get(k(p.lastSegment)) ?? p.lastSegment) : null,
    writtenAt: now(),
    ...(list ? { backends: list.list, vaultRevision: list.revision } : {}),
  };
  const loc = await createPointerMessage(io, key, accountId, hook);
  // A fresh message holds an empty pointer: write the copy unconditionally (writePointer would keep an
  // equally empty one for an account without snapshots yet).
  await io.slot(hook.id).write(loc.messageId, await sealObj(key, next, AAD.pointer(accountId)), "ddn-pointer.txt");
  old.push({ webhookId: oldLoc.webhookId, messageId: oldLoc.messageId, attachmentId: "", size: 0 });
  return { loc, pointer: next, old };
}

// --- restore: no server needed

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
 * Rebuild the tree from Discord alone. `atSeq`: point-in-time restore (within
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
  io.learn?.(pointer.backends ?? []);
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

/**
 * The encrypted log entries the segment chain holds, seq 1..pointer.toSeq (or from the first
 * kept segment after pruning). For a server that cannot decrypt operations (e2ee): rebuilding
 * an account's log after losing its database needs only this, the pointer location and the
 * key the chain was sealed with.
 */
export async function readLogChain(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation): Promise<{ pointer: Pointer; entries: EncryptedEntry[] }> {
  const pointer = await readPointer(io, key, accountId, loc);
  io.learn?.(pointer.backends ?? []);
  const segs: SegmentBody[] = [];
  let ref = pointer.lastSegment;
  let expectTo = pointer.toSeq;
  while (ref) {
    if (ref.toSeq !== expectTo) throw new Error(`segment chain gap: expected to=${expectTo}, got ${ref.toSeq}`);
    const body = await unsealObj<SegmentBody>(key, await io.fetch(toPlacement(ref)), AAD.segment(accountId, ref.fromSeq, ref.toSeq), "segment");
    if (body.fromSeq !== ref.fromSeq || body.toSeq !== ref.toSeq || body.entries.length !== body.toSeq - body.fromSeq + 1) throw new Error("segment does not match its reference");
    segs.unshift(body);
    expectTo = ref.fromSeq - 1;
    ref = body.prev;
  }
  const entries = segs.flatMap((s) => s.entries);
  for (let i = 1; i < entries.length; i++) if (entries[i]!.seq !== entries[i - 1]!.seq + 1) throw new Error("log chain not contiguous");
  return { pointer, entries };
}

// --- rescue kit

/** Kit 1 (metadata only): the pointer's webhook and message. Read forever; new kits are kit 3. */
export interface RescueKit {
  v: 1;
  accountId: string;
  /** Account key, base64. */
  key: string;
  /** One webhook URL (the pointer's). */
  webhookUrl: string;
  pointerMessageId: string;
}

/**
 * Kit 3 (metadata only): the pointer's backend and slot, plus the account's backend list when the kit
 * was made (the pointer carries the current list too; a restore takes both).
 */
export interface RescueKit3 {
  v: 3;
  accountId: string;
  key: string;
  backend: BackendDescriptor;
  slot: string;
  backends?: BackendDescriptor[];
}

/** Any metadata-only kit in one shape: where the pointer is and every backend the kit knows. */
export interface OpenedRescueKit {
  accountId: string;
  key: string;
  pointer: PointerLocation;
  backends: BackendDescriptor[];
  /** Format it came in (1 = old kit: one webhook). */
  v: 1 | 3;
}

/**
 * Rescue kit of the e2ee and plain modes: the webhooks belong to the instance, so the kit carries the
 * account key and the instance address only. Registers a new device with the rescue key, like kit 1.
 */
export interface ServerRescueKit {
  v: 2;
  accountId: string;
  key: string;
  server: string;
}

const b64u = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64u(t: string): unknown {
  let b = t.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return JSON.parse(dec.decode(fromBase64(b)));
}
const kitPrefix = (t: string) => /^ddn-kit(\d+):/.exec(t)?.[1];

export function encodeServerRescueKit(k: ServerRescueKit): string {
  return "ddn-kit2:" + b64u(enc.encode(JSON.stringify(k)));
}

export function decodeServerRescueKit(s: string): ServerRescueKit {
  const t = s.trim();
  if (!t.startsWith("ddn-kit2:")) throw new Error(kitPrefix(t) === "1" || kitPrefix(t) === "3" ? "kit of a metadata-only instance" : "not a rescue kit");
  const k = fromB64u(t.slice(9)) as ServerRescueKit;
  if (k.v !== 2 || !k.accountId || !k.key || !k.server) throw new Error("bad rescue kit");
  return k;
}

/** Compact text form for printing/QR: "ddn-kit1:" + base64url(JSON). Secret. */
export function encodeRescueKit(k: RescueKit): string {
  return "ddn-kit1:" + b64u(enc.encode(JSON.stringify(k)));
}

/** Kit 1 only (its own fields). Use openRescueKit to read every metadata-only kit. */
export function decodeRescueKit(s: string): RescueKit {
  const t = s.trim();
  if (!t.startsWith("ddn-kit1:")) throw new Error(t.startsWith("ddn-kit2:") ? "kit of an e2ee/plain instance" : t.startsWith("ddn-kit3:") ? "kit format 3: use openRescueKit" : "not a rescue kit");
  const k = fromB64u(t.slice(9)) as RescueKit;
  if (k.v !== 1 || !k.accountId || !k.key || !k.webhookUrl || !k.pointerMessageId) throw new Error("bad rescue kit");
  return k;
}

/** "ddn-kit3:" + base64url(JSON). Secret (account key and every webhook URL). */
export function encodeRescueKit3(k: RescueKit3): string {
  return "ddn-kit3:" + b64u(enc.encode(JSON.stringify(k)));
}

function validDescriptor(d: unknown): d is BackendDescriptor {
  const x = d as BackendDescriptor;
  return !!x && typeof x === "object" && typeof x.kind === "string" && typeof x.id === "string" && (x.kind !== DISCORD_PROVIDER || typeof x.url === "string");
}

/** Read a metadata-only rescue kit (format 1 or 3). */
export function openRescueKit(s: string): OpenedRescueKit {
  const t = s.trim();
  const v = kitPrefix(t);
  if (v === "2") throw new Error("kit of an e2ee/plain instance");
  if (v === "1") {
    const k = decodeRescueKit(t);
    const hook = parseWebhookUrl(k.webhookUrl);
    return { v: 1, accountId: k.accountId, key: k.key, pointer: { webhookId: hook.id, messageId: k.pointerMessageId }, backends: [{ kind: DISCORD_PROVIDER, id: hook.id, url: hook.url }] };
  }
  if (v !== "3") throw new Error("not a rescue kit");
  const k = fromB64u(t.slice(9)) as RescueKit3;
  if (k.v !== 3 || !k.accountId || !k.key || !validDescriptor(k.backend) || !k.slot || (k.backends !== undefined && !(Array.isArray(k.backends) && k.backends.every(validDescriptor)))) throw new Error("bad rescue kit");
  return { v: 3, accountId: k.accountId, key: k.key, pointer: { webhookId: k.backend.id, messageId: k.slot }, backends: mergeDescriptors([k.backend], k.backends ?? []) };
}

/** Union by backend ID, the first list wins (the kit's own entry, then newer lists). */
export function mergeDescriptors(...lists: BackendDescriptor[][]): BackendDescriptor[] {
  const out = new Map<string, BackendDescriptor>();
  for (const l of lists) for (const d of l) if (!out.has(d.id)) out.set(d.id, d);
  return [...out.values()];
}

// --- BlobIO adapters

/** BlobIO over a MetadataClient (paced posts, retried fetches, its backends). */
export function clientBlobIO(
  c: { postBlob(d: Uint8Array, f: string): Promise<Placement>; fetchPlacement(p: Placement): Promise<Uint8Array>; backend(id: string): BlobBackend },
  _transport?: WebhookTransport,
  partSize = 10 * 1024 * 1024,
): BlobIO {
  return {
    post: (d, f) => c.postBlob(d, f),
    fetch: (p) => c.fetchPlacement(p),
    remove: async (r) => void (await c.backend(r.webhookId).remove(toPlacement(r))),
    slot: (id) => c.backend(id).slot,
    partSize,
  };
}

/** Builds a read-only backend from a descriptor (a kind the app knows: Discord built in, others passed in). */
export type BackendFactory = (d: BackendDescriptor) => BlobBackend | null;

/**
 * Read-only BlobIO from a rescue kit: no server, no index, no vault. It starts with the kit's backends and
 * learns the rest from the pointer (`learn`, called by restore after reading it).
 */
export function rescueBlobIO(
  transport: WebhookTransport,
  kit: WebhookRef | BackendDescriptor[],
  o: { factory?: BackendFactory; links?: LinkAheadOptions } = {},
): BlobIO & { registry: BackendRegistry; known(): BackendDescriptor[] } {
  const dw = new DiscordWebhooks(transport, { log: null, net: null }, { links: o.links });
  const registry = new BackendRegistry();
  const descs = new Map<string, BackendDescriptor>();
  const add = (d: BackendDescriptor) => {
    if (registry.has(d.id)) return;
    let b: BlobBackend | null = null;
    if (d.kind === DISCORD_PROVIDER && d.url) b = dw.backend({ id: d.id, url: d.url, ...(d.channelId ? { channelId: d.channelId } : {}) });
    else b = o.factory?.(d) ?? null;
    if (b) (registry.add(b), descs.set(d.id, d));
  };
  for (const d of Array.isArray(kit) ? kit : [{ kind: DISCORD_PROVIDER, id: kit.id, url: kit.url }]) add(d);
  const get = (id: string): BlobBackend => {
    const b = registry.byId(id);
    if (!b) throw new Error(`object behind backend ${id}, which neither the rescue kit nor the pointer names`);
    return b;
  };
  return {
    registry,
    known: () => [...descs.values()],
    post: () => Promise.reject(new Error("read-only")),
    remove: () => Promise.reject(new Error("read-only")),
    fetch: (p) => get(p.locationId).get(p),
    slot: (id) => {
      const b = get(id);
      return { ...b.slot, create: () => Promise.reject(new Error("read-only")), write: () => Promise.reject(new Error("read-only")) };
    },
    learn: (list) => list.forEach(add),
    partSize: 0,
  };
}

/** The Discord pointer slot of one webhook (servers and tests without a client). */
export { discordSlot };

/**
 * Kit text above this length leaves the backend list out (the pointer carries it; keeps the QR code
 * readable): about 5 webhooks fit.
 */
export const KIT_LIST_MAX = 1600;

/**
 * The rescue kit of a metadata-only account (format 3): the pointer's backend and slot, and the other
 * backends when the text stays under `maxLen`. Make sure the pointer carries the current list first
 * (writePointer with the vault's list): a kit without the list relies on it.
 */
export function makeRescueKit(accountId: string, keyB64: string, pointer: PointerLocation, list: BackendDescriptor[], maxLen = KIT_LIST_MAX): string {
  const own = list.find((b) => b.id === pointer.webhookId);
  if (!own) throw new Error("pointer_hook_gone: the pointer's channel was removed from the vault");
  // The channel ID is learned again from Discord; leaving it out keeps the code (and its QR) shorter.
  const lean = ({ channelId: _c, ...d }: BackendDescriptor): BackendDescriptor => d;
  const base: RescueKit3 = { v: 3, accountId, key: keyB64, backend: lean(own), slot: pointer.messageId };
  const others = list.filter((b) => b.id !== own.id).map(lean);
  const full = encodeRescueKit3(others.length ? { ...base, backends: others } : base);
  return full.length <= maxLen ? full : encodeRescueKit3(base);
}

/** Descriptors split into what a MetadataClient takes: Discord webhooks, and other backends built by `factory`. */
export function clientBackends(list: BackendDescriptor[], factory?: BackendFactory): { webhooks: WebhookRef[]; backends: BlobBackend[] } {
  const webhooks: WebhookRef[] = [];
  const backends: BlobBackend[] = [];
  for (const d of list) {
    if (d.kind === DISCORD_PROVIDER) {
      if (d.url) webhooks.push({ id: d.id, url: d.url, ...(d.channelId ? { channelId: d.channelId } : {}) });
    } else {
      const b = factory?.(d);
      if (b) backends.push(b);
    }
  }
  return { webhooks, backends };
}

/**
 * Everything a device that has nothing but the rescue kit can rebuild, with no server and no vault: the
 * tree (at `atSeq`, default the newest snapshot) and every backend the kit and the pointer name (with
 * them, every file can be read again).
 */
export async function restoreFromRescueKit(
  kitText: string,
  transport: WebhookTransport,
  o: { factory?: BackendFactory; store?: IndexStore; atSeq?: number; links?: LinkAheadOptions } = {},
): Promise<RestoreResult & { kit: OpenedRescueKit; key: AccountKey; backends: BackendDescriptor[] }> {
  const kit = openRescueKit(kitText);
  const key = accountKeyFromB64(kit.key);
  const io = rescueBlobIO(transport, kit.backends, o);
  const r = await restoreFromDiscord(io, key, kit.accountId, kit.pointer, o.store, o.atSeq);
  return { ...r, kit, key, backends: io.known() };
}

// --- scheduler (metadata only: only while a client is open)

export interface SchedulerDeps extends SnapshotDeps {
  /** Device writes snapshots at all (main device / main tab). */
  isPrimary: () => boolean;
  /** Unmetered link: may write bases; phones only write segments. */
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
      if (decision === "none") {
        await this.refreshBackends();
        return null;
      }
      const r = await writeSnapshot(this.d, decision);
      this.history.push(r);
      // Re-read after a refused write (another device was ahead), else trust what we wrote.
      this.pointer = r.written === "written" ? r.pointer : await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
      if (r.kind === "base" && r.written === "written") {
        this.lastPrune = await pruneSnapshots(this.d.io, this.d.key, this.d.accountId, this.d.pointer, this.d.now, this.d.backends);
        this.pointer = await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
      }
      return r;
    } finally {
      this.running = false;
    }
  }

  /** Last outcome of refreshBackends (tests, diagnostics). */
  lastListWrite: "written" | "kept_newer" | "same" | null = null;

  /**
   * The pointer's copy of the backend list is older than the vault this device sees (or missing: written
   * by an older client): rewrite the pointer with the current list, coverage unchanged (same_coverage, so
   * a snapshot written meanwhile by another device is never undone).
   */
  async refreshBackends(): Promise<void> {
    const mine = this.d.backends?.();
    const p = this.pointer;
    if (!mine || !p) return;
    if ((p.vaultRevision ?? -1) > mine.revision || ((p.vaultRevision ?? -1) === mine.revision && sameBackends(p.backends, mine.list))) {
      this.lastListWrite = "same";
      return;
    }
    const next: Pointer = { ...p, backends: mine.list, vaultRevision: mine.revision, writtenAt: this.d.now() };
    this.lastListWrite = await writePointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer, next, "same_coverage");
    this.pointer = this.lastListWrite === "written" ? next : await readPointer(this.d.io, this.d.key, this.d.accountId, this.d.pointer);
  }
}
