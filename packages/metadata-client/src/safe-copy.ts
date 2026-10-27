// Copies of the Safe on the account's channels, next to the snapshot chain.
//
// The Safe's slot lives on the instance (safe.ts). Without a copy elsewhere, losing the instance's database
// loses the Safe, while the rest of the account comes back from its snapshots on Discord. So the slot is
// copied into the chain: the pointer (sealed with the account's snapshot key, or the instance's in e2ee/plain)
// lists the copies, each one the slot's blob as it is (still sealed with the account key and the Safe's
// master) sealed once more with the snapshot key for its revision (AAD ddn-safe-copy-v1|account|revision).
// The rescue kit, which reaches the pointer, therefore reaches the Safe too, and only the Safe's password
// (or a Safe kit) opens it: the copy adds no reader.
//
// Which copies: the slot is copied when it changed (after a quiet minute, at the latest 5 minutes after
// the first change, like a segment), so not every revision gets one. A copy is kept while the instance still
// keeps that revision (the slot or its history: the last 20, every one from the last 30 days, at most 200),
// at most SAFE_COPY_MAX of them, and goes when the instance lets it go. A new password drops the instance's
// history, so the copies under the old password go too, with the next copy. Copies are written where the
// snapshots are: by the main tab / desktop agent in metadata only, by the instance in e2ee and plain.
//
// Back: a device that finds the instance's slot older than the newest copy (a database restored from an old
// backup, or lost and the account brought back) puts the copies back (the history, then the slot under its
// own revision: the instance accepts a jump forward). With no instance at all, the copies open read-only.

import { fromBase64, toBase64 } from "@ddv4/processing";
import type { AccountKey } from "./account-key.js";
import { sha256Hex } from "./file-crypto.js";
import { openRescueKit, openSafeCopy, readPointer, rescueBlobIO, sealSafeCopy, toPlacement, toRef, updatePointer, type BackendFactory, type BlobIO, type Pointer, type PointerLocation, type SafeCopyRef } from "./snapshots.js";
import type { LinkAheadOptions } from "./link-ahead.js";
import type { WebhookTransport } from "./types.js";
import { accountKeyFromB64 } from "./account-key.js";
import { SAFE_SLOT, SafeStore, type SlotApi } from "./safe.js";

export const SAFE_COPY_FILE = "ddn-safe.txt";
/** A changed slot is copied after this long without another change... */
export const SAFE_COPY_QUIET_MS = 60_000;
/** ...and at the latest this long after the first change not copied yet. */
export const SAFE_COPY_MAX_DELAY_MS = 5 * 60_000;
/** How often an open client asks the instance for the slot's revision. */
export const SAFE_COPY_CHECK_MS = 60_000;
/** Most copies kept (a state is up to 1 MiB: at most ~20 MiB on the channel). */
export const SAFE_COPY_MAX = 20;

/** The slot as the copier sees it on the instance. */
export interface SafeSlotSource {
  /** The slot now (null = none). */
  current(): Promise<{ revision: number; blob: string } | null>;
  /** Revisions the instance keeps (the slot's and its history's): copies of others go. */
  kept(): Promise<Set<number>>;
}

export interface SafeCopyResult {
  /** The copy of the current slot posted and listed (null = it had one already, or nothing to copy). */
  copied: SafeCopyRef | null;
  /** Copies that left the list (their messages deleted). */
  dropped: SafeCopyRef[];
  /** The instance's slot is older than the newest copy (or gone): put the copies back (putBackSafe). */
  behind: SafeCopyRef | null;
}

const tag = async (b: Uint8Array) => (await sha256Hex(b)).slice(0, 16);

/**
 * One copy round: post the current slot if the pointer has no copy of its revision, drop the copies of
 * revisions the instance no longer keeps, and say when the instance is behind the copies (nothing is touched
 * then: it is the copies that must go back, not be dropped).
 */
export async function syncSafeCopies(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation, src: SafeSlotSource, now: () => number): Promise<SafeCopyResult> {
  const p = await readPointer(io, key, accountId, loc);
  const have = p.safe?.copies ?? [];
  const cur = await src.current();
  const newest = have[0] ?? null;
  if (newest && (!cur || cur.revision < newest.revision)) return { copied: null, dropped: [], behind: newest };
  if (!cur) return { copied: null, dropped: [], behind: null };
  const kept = await src.kept();
  kept.add(cur.revision);
  const raw = fromBase64(cur.blob);
  const h = await tag(raw);
  let mine: SafeCopyRef | null = null;
  if (!have.some((c) => c.revision === cur.revision && c.h === h)) {
    const sealed = await sealSafeCopy(key, accountId, cur.revision, raw);
    const at = await io.post(sealed, SAFE_COPY_FILE);
    mine = { ...toRef(at, sealed.byteLength), revision: cur.revision, h, copiedAt: now() };
  }
  let dropped: SafeCopyRef[] = [];
  const r = await updatePointer(io, key, accountId, loc, (fresh) => {
    const list = fresh.safe?.copies ?? [];
    const merged = mine ? [mine, ...list.filter((c) => c.revision !== mine!.revision)] : [...list];
    merged.sort((a, b) => b.revision - a.revision);
    // Never drop above what this round saw on the instance (a newer copy written meanwhile by another device).
    const keep = merged.filter((c) => c.revision > cur.revision || kept.has(c.revision)).slice(0, SAFE_COPY_MAX);
    dropped = merged.filter((c) => !keep.includes(c));
    if (!mine && dropped.length === 0) return null;
    return { ...fresh, safe: { copies: keep }, writtenAt: now() };
  });
  if (!r.written && mine) await io.remove(mine).catch(() => {});
  for (const d of dropped) await io.remove(d).catch(() => {});
  return { copied: r.written ? mine : null, dropped: r.written ? dropped : [], behind: null };
}

/** Every copy the pointer lists, opened to the slot's blob (base64), newest first. */
export async function readSafeCopies(io: BlobIO, key: AccountKey, accountId: string, p: Pointer): Promise<{ revision: number; blob: string; copiedAt: number }[]> {
  const out: { revision: number; blob: string; copiedAt: number }[] = [];
  for (const c of p.safe?.copies ?? []) {
    const raw = await openSafeCopy(key, accountId, c.revision, await io.fetch(toPlacement(c)));
    out.push({ revision: c.revision, blob: toBase64(raw), copiedAt: c.copiedAt });
  }
  return out;
}

/** The instance's calls putting the copies back (HttpApi has them). */
export interface SafePutBackApi {
  getSlot(name: string): Promise<{ revision: number; blob: string | null }>;
  putSlot(name: string, expectedRevision: number, revision: number, blob: string): Promise<{ revision: number; blob: string | null } | null>;
  /** Add an earlier revision to the slot's history (older than the slot; one the instance has is left alone). */
  putSlotHistory?(name: string, revision: number, blob: string, replacedAt: number): Promise<boolean>;
}

/**
 * Put the copies back on an instance that is behind them: the newest as the slot, under its own revision
 * (the instance accepts the jump), then the older ones into the slot's history, so that the next copy round
 * keeps them. Whatever the instance had (an older slot, or a Safe made meanwhile) goes to its history, not
 * away. Returns the revision put back, or null when the instance is not behind (any more).
 */
export async function putBackSafe(io: BlobIO, key: AccountKey, accountId: string, loc: PointerLocation, api: SafePutBackApi): Promise<number | null> {
  const p = await readPointer(io, key, accountId, loc);
  const copies = await readSafeCopies(io, key, accountId, p);
  const top = copies[0];
  if (!top) return null;
  const cur = await api.getSlot(SAFE_SLOT);
  if (cur.revision >= top.revision) return null;
  const won = await api.putSlot(SAFE_SLOT, cur.revision, top.revision, top.blob);
  if (won) return null;
  if (api.putSlotHistory) for (const c of copies.slice(1)) await api.putSlotHistory(SAFE_SLOT, c.revision, c.blob, c.copiedAt).catch(() => false);
  return top.revision;
}

/** A read-only slot API over the copies (no instance): the newest is the slot, the others its history. */
export function copiesSlotApi(copies: { revision: number; blob: string; copiedAt: number }[]): SlotApi {
  const ro = () => Promise.reject(new Error("read-only: the Safe was opened from its copies on Discord"));
  return {
    getSlot: async () => (copies[0] ? { revision: copies[0].revision, blob: copies[0].blob } : { revision: 0, blob: null }),
    putSlot: ro,
    slotHistory: async () => copies.slice(1).map((c) => ({ revision: c.revision, replacedAt: c.copiedAt, chars: c.blob.length })),
    slotRevision: async (_n, revision) => {
      const c = copies.find((x) => x.revision === revision);
      if (!c) throw new Error("no such revision");
      return { revision: c.revision, blob: c.blob };
    },
  };
}

/**
 * The Safe from the account's rescue kit alone (no instance, no device): its copies on Discord, opened
 * read-only. The Safe's password (or its kit) still decides who opens it: `store.unlock(password)`.
 */
export async function safeFromRescueKit<S = unknown>(
  kitText: string,
  transport: WebhookTransport,
  o: { factory?: BackendFactory; links?: LinkAheadOptions } = {},
): Promise<{ store: SafeStore<S>; copies: { revision: number; blob: string; copiedAt: number }[] }> {
  const kit = openRescueKit(kitText);
  const key = accountKeyFromB64(kit.key);
  const io = rescueBlobIO(transport, kit.backends, o);
  const p = await readPointer(io, key, kit.accountId, kit.pointer);
  io.learn?.(p.backends ?? []);
  const copies = await readSafeCopies(io, key, kit.accountId, p);
  return { store: new SafeStore<S>(copiesSlotApi(copies), key, kit.accountId), copies };
}

/** The instance as a SafeSlotSource (HttpApi). */
export function instanceSlotSource(api: { getSlot(name: string): Promise<{ revision: number; blob: string | null }>; slotHistory?(name: string): Promise<{ revision: number }[]> }): SafeSlotSource {
  return {
    current: async () => {
      const r = await api.getSlot(SAFE_SLOT);
      return r.blob === null ? null : { revision: r.revision, blob: r.blob };
    },
    kept: async () => new Set((await (api.slotHistory?.(SAFE_SLOT) ?? Promise.resolve([]))).map((h) => h.revision)),
  };
}

/**
 * A client's copier (metadata only: the main tab / the desktop agent, next to its snapshot scheduler). Call
 * tick() as often as the scheduler: it asks the instance for the slot's revision at most every
 * SAFE_COPY_CHECK_MS and copies a changed slot once it has been quiet for SAFE_COPY_QUIET_MS (at the latest
 * SAFE_COPY_MAX_DELAY_MS after the first change). The first round after start compares with the pointer at
 * once: an instance behind the copies gets them back before anyone works with the Safe. `touch()` after this
 * device wrote the Safe: the next tick asks at once.
 */
export class SafeCopier {
  private seenRev = -1;
  private copiedRev = -1;
  private firstAt = 0;
  private lastAt = 0;
  private checkedAt = -Infinity;
  private running = false;
  private started = false;
  last: (SafeCopyResult & { putBack: number | null; at: number }) | null = null;

  constructor(
    private readonly d: {
      io: BlobIO;
      key: AccountKey;
      accountId: string;
      pointer: () => PointerLocation | null;
      api: SafePutBackApi & { slotMeta?(name: string): Promise<{ revision: number }>; slotHistory?(name: string): Promise<{ revision: number }[]> };
      now: () => number;
    },
  ) {}

  touch(): void {
    this.checkedAt = -Infinity;
  }

  async tick(force = false): Promise<SafeCopier["last"]> {
    const loc = this.d.pointer();
    if (this.running || !loc) return null;
    const now = this.d.now();
    if (!force && this.started && now - this.checkedAt < SAFE_COPY_CHECK_MS) return null;
    this.running = true;
    try {
      this.checkedAt = now;
      const rev = this.d.api.slotMeta ? (await this.d.api.slotMeta(SAFE_SLOT)).revision : (await this.d.api.getSlot(SAFE_SLOT)).revision;
      if (rev !== this.seenRev) {
        if (!this.firstAt) this.firstAt = now;
        this.lastAt = now;
        this.seenRev = rev;
      }
      const due = now - this.lastAt >= SAFE_COPY_QUIET_MS || now - this.firstAt >= SAFE_COPY_MAX_DELAY_MS;
      if (!force && this.started && (rev === this.copiedRev || !due)) return null;
      this.started = true;
      const src = instanceSlotSource(this.d.api);
      let r = await syncSafeCopies(this.d.io, this.d.key, this.d.accountId, loc, src, this.d.now);
      let putBack: number | null = null;
      if (r.behind) {
        putBack = await putBackSafe(this.d.io, this.d.key, this.d.accountId, loc, this.d.api);
        if (putBack !== null) r = await syncSafeCopies(this.d.io, this.d.key, this.d.accountId, loc, src, this.d.now);
      }
      this.copiedRev = putBack ?? rev;
      this.seenRev = this.copiedRev;
      this.firstAt = 0;
      this.last = { ...r, putBack, at: now };
      return this.last;
    } finally {
      this.running = false;
    }
  }
}
