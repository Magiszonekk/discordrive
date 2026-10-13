// Removing a channel (webhook) in metadata only (zlecenie 2026-10-13-webhooki p. 1).
//
// Everything runs in the client: the server never holds a webhook and cannot read the tree.
//   impact   what lies on webhook W: files with a piece there (local index, pieces table), its
//            snapshot objects (pointer message, chain segments, base parts), critical or not.
//   retire   vault flag: no new pieces go to W, it is still read. Instant, reversible.
//   move     (resumable, state in the local index database)
//            1. W is retired (nothing new lands there while it is emptied);
//            2. every current version with a piece on W: its pieces on W are copied (ciphertext hash
//               checked) to the other active webhooks with a new manifest, and a `relocate` op (rules
//               v3: same content, new locator, never a conflict) is committed per batch;
//            3. the snapshot chain, when W holds any of it (critical): copied to another channel with
//               its kept history (rehomeChain), the vault points at the new pointer message, a new
//               rescue kit is forced (the old one names a pointer that is no longer updated);
//            4. W is marked "drain" in the vault: retired, read only, out of every count. Older log
//               entries and the snapshot bases kept for 30 days still name its messages (§6.2: a
//               restored base must never point at a deleted message), so the old messages are
//               deleted by the cleanup once the retention passed; then W leaves the vault ("moved").
//   remove   (anyway) W leaves the vault at once ("removed"); files with a piece there become
//            unavailable (computed from vault + pieces, never an op), nothing is deleted. Pasting
//            the same webhook again (same ID) makes them readable again at once on every device.
// Critical (owner decision): W holds the pointer message or objects the current pointer reaches.
// Only "move" for it (retire/remove refused), and it is refused for the last active channel.

import { DAY_MS, FRAGMENT_RETENTION_MS, type ChunkManifest, type Operation, type SingleOp } from "@ddv4/sync-core";
import type { AccountKey } from "./account-key.js";
import type { ArbiterApi } from "./arbiter.js";
import { BLOB_EXT, decodeManifestRef, encodeManifestRef, newId, piecesOf, type DriveClient } from "./drive-client.js";
import { encryptManifest, importFileKey, decryptManifest, sha256Hex } from "./file-crypto.js";
import { RateLimitedError } from "./discord-transport.js";
import { chainObjects, clientBlobIO, readPointer, rehomeChain, type BaseRef, type BlobIO, type Pointer, type PointerLocation, type SegmentRef } from "./snapshots.js";
import type { SqlIndexStore } from "./sql-store.js";
import type { DiscordPlacement, WebhookRef, WebhookTransport } from "./types.js";
import type { VaultContent, VaultWebhook, WebhookVault } from "./vault.js";

/** Rough throughput of one channel for ETAs (koncept §7: ~30 posts/min of ≤ 10 MiB). */
export const BYTES_PER_S_PER_CHANNEL = 4 * 1024 * 1024;
/** Versions moved per relocate group op (one log entry; Q9 leaves stale members out). */
export const RELOCATE_BATCH = 20;
/** A drained webhook is deleted from after the fragment retention + a day of margin for kept bases. */
export const DRAIN_AFTER_MS = FRAGMENT_RETENTION_MS + DAY_MS;

export interface ChannelClient extends DriveClient {
  fetchPlacement(p: DiscordPlacement): Promise<Uint8Array>;
  postBlob(d: Uint8Array, f: string): Promise<DiscordPlacement>;
  postBlobExcept(d: Uint8Array, f: string, exclude: ReadonlySet<string>): Promise<DiscordPlacement>;
  postBlobTo(hookId: string, d: Uint8Array, f: string): Promise<DiscordPlacement>;
  webhook(id: string): WebhookRef;
  readonly webhooks: WebhookRef[];
  /** Stop/resume posting to one webhook in this client (the vault flag is the durable part). */
  setHookRetired(id: string, retired: boolean): void;
}

export interface ChannelsDeps {
  client: ChannelClient;
  store: SqlIndexStore;
  vault: WebhookVault;
  key: AccountKey;
  accountId: string;
  transport: WebhookTransport;
  /** The log (the drain reads the relocate entries it covers). */
  log: Pick<ArbiterApi, "read">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type CriticalWhat = "pointer" | "snapshots";

/** Which webhooks hold the account's snapshot data: the pointer message, and objects the pointer reaches (walked). */
export async function snapshotHooks(io: BlobIO, key: AccountKey, accountId: string, v: VaultContent): Promise<Map<string, CriticalWhat[]>> {
  const out = new Map<string, CriticalWhat[]>();
  const add = (id: string, what: CriticalWhat) => {
    const l = out.get(id) ?? [];
    if (!l.includes(what)) l.push(what);
    out.set(id, l);
  };
  if (!v.pointer) return out;
  add(v.pointer.webhookId, "pointer");
  const p = await readPointer(io, key, accountId, v.pointer);
  const { segments, parts } = await chainObjects(io, key, accountId, p);
  for (const s of segments) add(s.ref.webhookId, "snapshots");
  for (const o of parts) add(o.webhookId, "snapshots");
  return out;
}

/**
 * Which webhooks hold the account's snapshot data, without walking the whole chain every time: the
 * walk result (segment → webhook) is kept in the local index database and extended from the pointer's
 * newest segment back to the last one already known; pruned segments (toSeq <= prunedUpTo) drop out.
 * One full walk per device and pointer message (an old account with a long chain: once, in the
 * background); afterwards a GET per new segment. Exact, and no format change on Discord.
 */
export class ChainIndex {
  private mem: string | null = null;
  constructor(private readonly kv?: { get(): string | null; set(v: string): void }) {}

  private load(): { ptr: string; segs: [number, number, string, string, number][] } | null {
    const v = this.kv ? this.kv.get() : this.mem;
    return v ? JSON.parse(v) : null;
  }
  private store(x: { ptr: string; segs: [number, number, string, string, number][] }): void {
    const v = JSON.stringify(x);
    if (this.kv) this.kv.set(v);
    else this.mem = v;
  }

  /** [webhookId → what] plus the bytes of snapshot objects per webhook (Settings → Storage, the move's size). */
  async hooks(io: BlobIO, key: AccountKey, accountId: string, v: VaultContent): Promise<{ what: Map<string, CriticalWhat[]>; bytes: Map<string, number> }> {
    const what = new Map<string, CriticalWhat[]>();
    const bytes = new Map<string, number>();
    if (!v.pointer) return { what, bytes };
    const add = (id: string, w: CriticalWhat, b: number) => {
      const l = what.get(id) ?? [];
      if (!l.includes(w)) l.push(w);
      what.set(id, l);
      bytes.set(id, (bytes.get(id) ?? 0) + b);
    };
    add(v.pointer.webhookId, "pointer", 0);
    const p = await readPointer(io, key, accountId, v.pointer);
    const ptr = `${v.pointer.webhookId}/${v.pointer.messageId}`;
    let st = this.load();
    if (!st || st.ptr !== ptr) st = { ptr, segs: [] };
    const known = st.segs[0];
    const fresh: [number, number, string, string, number][] = [];
    let ref = p.lastSegment;
    const done = p.prunedUpTo ?? 0;
    let joined = !known;
    while (ref && ref.toSeq > done) {
      if (known && ref.toSeq <= known[0]) {
        joined = ref.toSeq === known[0] && ref.messageId === known[3];
        break;
      }
      fresh.push([ref.toSeq, ref.fromSeq, ref.webhookId, ref.messageId, ref.size]);
      const body = await unsealSegment(io, key, accountId, ref);
      ref = body.prev;
    }
    // The chain does not join what was stored (it was rewritten): walk it all again next time from scratch.
    st.segs = joined || !known ? [...fresh, ...st.segs] : fresh;
    st.segs = st.segs.filter((x) => x[0] > done);
    this.store(st);
    for (const s of st.segs) add(s[2], "snapshots", s[4]);
    for (const b of pointerBases(p)) for (const part of b.parts) add(part.webhookId, "snapshots", part.size);
    return { what, bytes };
  }
}

async function unsealSegment(io: BlobIO, key: AccountKey, accountId: string, ref: SegmentRef): Promise<{ prev: SegmentRef | null }> {
  // Only the link back is needed; chainObjects returns the whole body, reuse it for one segment.
  const { segments } = await chainObjects(io, key, accountId, { v: 1, toSeq: ref.toSeq, base: null, lastSegment: ref, segmentBytesSinceBase: 0, writtenAt: 0, prunedUpTo: ref.fromSeq - 1 });
  return { prev: segments[0]?.body.prev ?? null };
}

export interface MoveState {
  webhookId: string;
  label: string;
  state: "running" | "paused" | "done" | "failed";
  critical: boolean;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  etaMs: number | null;
  error?: string;
  /** Log position before the first relocate of this move (the drain deletes what relocates after it replaced). */
  fromSeq?: number;
  /** A critical move: the chain was copied and the vault points at the new pointer. */
  newPointer?: PointerLocation;
  /** The pointer before (its chain is deleted by the drain, after the retention). */
  oldPointer?: PointerLocation;
  newKitNeeded?: boolean;
}

const MOVE_KEY = "channel_move";

/** One move at a time per device; the state lives in the local index database (meta table), so a closed tab resumes. */
export class ChannelMover {
  private running: Promise<MoveState> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: ChannelsDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  state(): MoveState | null {
    const r = this.d.store.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", [MOVE_KEY]);
    return r ? (JSON.parse(r.v) as MoveState) : null;
  }

  private save(s: MoveState): MoveState {
    s.updatedAt = this.now();
    const secs = (s.updatedAt - s.startedAt) / 1000;
    if (s.state === "running" && s.bytesDone > 0 && secs > 0) s.etaMs = Math.round(((s.bytesTotal - s.bytesDone) / (s.bytesDone / secs)) * 1000);
    if (s.state === "done") s.etaMs = 0;
    this.d.store.sql.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [MOVE_KEY, JSON.stringify(s)]);
    return s;
  }

  get busy(): boolean {
    return !!this.running;
  }

  /** Start (or resume) the move of `webhookId`; resolves when it finished or stopped (state paused + error). */
  run(webhookId: string, onProgress?: (s: MoveState) => void): Promise<MoveState> {
    this.running ??= this.go(webhookId, onProgress).finally(() => (this.running = null));
    return this.running;
  }

  private async go(webhookId: string, onProgress?: (s: MoveState) => void): Promise<MoveState> {
    const d = this.d;
    let v = await d.vault.load();
    const hook = v.webhooks.find((w) => w.id === webhookId);
    const prev = this.state();
    if (!hook || hook.drain) {
      if (prev?.webhookId === webhookId && prev.state === "done") return prev;
      throw new Error("no_such_channel");
    }
    const others = v.webhooks.filter((w) => w.id !== webhookId && !w.retired && !w.drain);
    if (!others.length) throw new Error("need_other_channel");
    const io = clientBlobIO(d.client, d.transport);
    const crit = (await snapshotHooks(io, d.key, d.accountId, v).catch(() => new Map<string, CriticalWhat[]>())).get(webhookId) ?? [];
    if (!hook.retired) v = await d.vault.setRetired(webhookId, true);
    d.client.setHookRetired(webhookId, true);
    await d.client.pull();
    const at = d.store.filesAt(webhookId, 0);
    const s: MoveState =
      prev && prev.webhookId === webhookId && prev.state !== "done"
        ? { ...prev, state: "running", error: undefined }
        : {
            webhookId,
            label: hook.label,
            state: "running",
            critical: crit.length > 0,
            done: 0,
            total: at.total,
            bytesDone: 0,
            bytesTotal: at.bytes,
            startedAt: this.now(),
            updatedAt: this.now(),
            etaMs: estimateMs(at.bytes, others.length),
            fromSeq: d.client.replica.headSeq,
          };
    s.critical ||= crit.length > 0;
    onProgress?.(this.save(s));
    const exclude = new Set([webhookId]);
    try {
      // 2. Files.
      for (;;) {
        await d.client.pull();
        const batch = d.store.versionsAt(webhookId, "", RELOCATE_BATCH);
        if (!batch.length) break;
        const ops: SingleOp[] = [];
        for (const b of batch) {
          const versionId = d.store.getUpload(b.uploadId)?.boundTo?.versionId;
          if (!versionId) continue;
          const moved = await this.copyVersion(b.manifestRef, webhookId, exclude);
          ops.push({ type: "relocate", uploadId: b.uploadId, versionId, from: b.manifestRef, manifestRef: moved.manifestRef, pieces: moved.pieces });
          s.bytesDone += b.size;
        }
        if (ops.length) {
          await d.client.commitOp(ops.length === 1 ? ops[0]! : { type: "group", ops }, "relocate").catch((e: unknown) => {
            // Every member stale (purged / superseded / moved by another device meanwhile): the copies are
            // garbage nobody references; the loop reads the work list again.
            if ((e as { result?: { outcome?: string } })?.result?.outcome !== "skipped") throw e;
          });
        }
        s.done = Math.min(s.total, s.done + batch.length);
        s.total = Math.max(s.total, s.done + d.store.filesAt(webhookId, 0).total);
        onProgress?.(this.save(s));
      }
      // 3. Snapshot chain (critical).
      v = await d.vault.load();
      const holds = (await snapshotHooks(io, d.key, d.accountId, v).catch(() => new Map<string, CriticalWhat[]>())).get(webhookId) ?? [];
      if (holds.length && v.pointer) {
        const target = d.client.webhook(others[0]!.id);
        const r = await rehomeChain(io, d.key, d.accountId, v.pointer, target, (data, f) => d.client.postBlobTo(target.id, data, f), this.now);
        await d.vault.update((x) => {
          x.pointer = r.loc;
          return x;
        });
        s.oldPointer = v.pointer;
        s.newPointer = r.loc;
        s.newKitNeeded = true;
        s.critical = true;
        onProgress?.(this.save(s));
      }
      // 4. Drain: nothing current on W any more.
      await d.client.pull();
      if (d.store.filesAt(webhookId, 0).total > 0) throw new Error("move_incomplete");
      await d.vault.setDrain(webhookId, { at: this.now(), fromSeq: s.fromSeq ?? 0, toSeq: d.client.replica.headSeq, ...(s.oldPointer ? { oldPointer: s.oldPointer } : {}) });
      s.state = "done";
      onProgress?.(this.save(s));
      return s;
    } catch (e) {
      s.state = "paused";
      s.error = String((e as Error)?.message ?? e).slice(0, 300);
      onProgress?.(this.save(s));
      return s;
    }
  }

  /** Pieces of one version that are on `from` go to the active webhooks (minus `exclude`), hash-checked; a new manifest. */
  private async copyVersion(manifestRef: string, from: string, exclude: ReadonlySet<string>): Promise<{ manifestRef: string; pieces: ReturnType<typeof piecesOf> }> {
    const c = this.d.client;
    const loc = decodeManifestRef(manifestRef);
    const key = await importFileKey(loc.k);
    const manifest = await decryptManifest(key, await c.fetchPlacement(loc.at));
    const chunks: ChunkManifest["chunks"] = [];
    for (const ch of manifest.chunks) {
      const p = ch.placements?.[0] as DiscordPlacement | undefined;
      if (!p || p.locationId !== from) {
        chunks.push(ch);
        continue;
      }
      const ct = await c.fetchPlacement(p);
      if (ch.ciphertextHash && (await sha256Hex(ct)) !== ch.ciphertextHash) throw new Error(`chunk ${ch.index}: ciphertext hash mismatch`);
      chunks.push({ ...ch, placements: [await c.postBlobExcept(ct, `${ch.blobId}${BLOB_EXT}`, exclude)] });
    }
    const m2: ChunkManifest = { ...manifest, chunks };
    const mct = await encryptManifest(key, m2);
    const at = await c.postBlobExcept(mct, `${newId()}${BLOB_EXT}`, exclude);
    return { manifestRef: encodeManifestRef({ ...loc, at }), pieces: piecesOf(m2, at, mct.byteLength) };
  }
}

export function estimateMs(bytes: number, channels: number): number | null {
  if (channels <= 0) return null;
  return Math.round((bytes / (BYTES_PER_S_PER_CHANNEL * channels)) * 1000);
}

/** metadata only "unavailable": uploads with a piece on a webhook outside the vault; refreshed into the local table. */
export function refreshUnavailable(store: SqlIndexStore, v: VaultContent): { uploadId: string; webhookIds: string[] }[] {
  const out = store.uploadsOutside(v.webhooks.map((w) => w.id));
  store.setUnavailable(out);
  return out.map((x) => ({ uploadId: x.uploadId, webhookIds: x.locs }));
}

/**
 * Versions written without piece locations (rules 2, older tabs): read their manifests and fill the
 * locations in locally. `budget` manifests per call; the caller repeats until nothing is left. A
 * manifest on a webhook that is not in the vault cannot be read: the incomplete row (the manifest's
 * own place) already makes the file unavailable, nothing more to learn.
 */
export async function backfillPieces(c: ChannelClient, store: SqlIndexStore, budget = 100): Promise<{ filled: number; left: number }> {
  const todo = store.versionsWithoutPieces(budget);
  let filled = 0;
  const known = new Set(c.webhooks.map((h) => h.id));
  for (const t of todo) {
    try {
      const loc = decodeManifestRef(t.manifestRef);
      if (!known.has(loc.at.locationId)) continue;
      const raw = await c.fetchPlacement(loc.at);
      const m = await decryptManifest(await importFileKey(loc.k), raw);
      store.atomically(() => store.setPieces(t.uploadId, t.manifestRef, piecesOf(m, loc.at, raw.byteLength), true));
      filled++;
    } catch {
      /* unreadable now (network): stays incomplete, tried again later */
    }
  }
  return { filled, left: store.versionsWithoutPieces(1).length };
}

/**
 * The cleanup's last step for a drained webhook W: once the retention passed (DRAIN_AFTER_MS since the
 * move AND every kept snapshot base was taken after it, the §6.2 rule deletableUploadsWithRetention
 * applies to released fragments), delete what the move left behind - the pieces on W of the manifests
 * the relocates in fromSeq..toSeq replaced, those old manifests, and the old snapshot chain when the
 * move re-homed it - then W leaves the vault ("moved").
 */
export async function finishDrain(
  d: Pick<ChannelsDeps, "client" | "vault" | "log" | "transport" | "key" | "accountId"> & { sleep?: (ms: number) => Promise<void> },
  w: VaultWebhook,
  now: number,
  oldestBaseSeq: number,
): Promise<{ messages: number; done: boolean }> {
  if (!w.drain || now - w.drain.at < DRAIN_AFTER_MS || oldestBaseSeq < w.drain.toSeq) return { messages: 0, done: false };
  let messages = 0;
  const del = async (hookId: string, messageId: string) => {
    let hook: WebhookRef;
    try {
      hook = d.client.webhook(hookId);
    } catch {
      return; // not in the vault (removed): cannot be deleted by us
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await d.transport.deleteMessage(hook, messageId);
        messages++;
        return;
      } catch (e) {
        if (/404|Unknown (Message|Webhook)/.test(String((e as Error)?.message ?? e))) return;
        if (e instanceof RateLimitedError && attempt < 8) {
          await (d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(Math.min(e.retryAfterMs, 30_000));
          continue;
        }
        throw e;
      }
    }
  };
  for (let at = w.drain.fromSeq; at < w.drain.toSeq; ) {
    const batch = await d.log.read(at, Math.min(500, w.drain.toSeq - at));
    if (!batch.length) break;
    for (const e of batch) {
      const ops: Operation[] = e.op?.type === "group" ? e.op.ops : e.op ? [e.op] : [];
      for (const o of ops) {
        if (o.type !== "relocate" || o.from === o.manifestRef) continue;
        let loc;
        try {
          loc = decodeManifestRef(o.from);
        } catch {
          continue;
        }
        // Pieces first, the old manifest last (a cut run repeats from the manifest).
        const m = await d.client.loadManifest(o.from).catch(() => null);
        for (const ch of m?.manifest.chunks ?? []) {
          const p = ch.placements?.[0] as DiscordPlacement | undefined;
          if (p?.locationId === w.id) await del(p.locationId, p.messageId);
        }
        await del(loc.at.locationId, loc.at.messageId);
      }
    }
    at = batch.at(-1)!.seq;
  }
  if (w.drain.oldPointer) {
    const io = clientBlobIO(d.client, d.transport);
    const p = await readPointer(io, d.key, d.accountId, w.drain.oldPointer).catch(() => null);
    if (p) {
      const { segments, parts } = await chainObjects(io, d.key, d.accountId, p);
      for (const s of segments) await del(s.ref.webhookId, s.ref.messageId);
      for (const o of parts) await del(o.webhookId, o.messageId);
    }
    await del(w.drain.oldPointer.webhookId, w.drain.oldPointer.messageId);
  }
  await d.vault.removeWebhook(w.id, "moved", now);
  return { messages, done: true };
}

/** Bases reachable from a pointer (for oldest-base checks). */
export function pointerBases(p: Pointer): BaseRef[] {
  return [p.base, ...(p.history ?? [])].filter((b): b is BaseRef => !!b);
}
