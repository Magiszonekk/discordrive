// Metadata-only mode of the browser app: webhooks in the encrypted vault, blobs
// straight to Discord, snapshots written by the main tab, rescue kit with the pointer webhook.
import {
  ChainIndex,
  ChannelMover,
  Cleaner,
  backfillPieces,
  finishDrain,
  DiscordWebhookTransport,
  SqlIndexStore,
  estimateMs,
  refreshUnavailable,
  EncryptedArbiter,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  SafeCopier,
  WebhookVault,
  clientBlobIO,
  createPointerMessage,
  makeRescueKit,
  openRescueKit,
  readPointer as readPtr,
  writePointer,
  sameBackends,
  backendDescriptors,
  activeBackends,
  inspectForVault,
  prepareShare,
  toWebhookRefs,
  vaultAdvice,
  type DriveClient,
} from "@ddv4/metadata-client";
import type { ChannelRow, ModeCtx, ModeImpl, MoveStatus, RemovalImpact } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:metadata-only";

const transport = (ctx: ModeCtx) => new DiscordWebhookTransport({ apiOrigin: ctx.discordApiOrigin, fetch: ctx.discordFetch });
const vaults = new WeakMap<ModeCtx, WebhookVault>();
const vault = (ctx: ModeCtx) => {
  let v = vaults.get(ctx);
  if (!v) vaults.set(ctx, (v = new WebhookVault(ctx.http, ctx.key, ctx.acct.accountId)));
  return v;
};
const mc = (c: DriveClient) => c as MetadataClient;

/**
 * The account's backend list as the pointer carries it: from the vault this tab last read (the pointer
 * is rewritten with it whenever its copy is older). Null before the first vault read.
 */
const backendsOf = (ctx: ModeCtx) => () => {
  const v = vault(ctx).cached;
  return v ? { list: backendDescriptors(v.content), revision: v.revision } : null;
};

async function ensurePointer(ctx: ModeCtx, c: DriveClient) {
  let v = await vault(ctx).load();
  if (v.pointer) return v.pointer;
  const hooks = toWebhookRefs(v).filter((h) => !h.retired);
  if (!hooks.length) throw new Error("need_channel: add a channel with a webhook first");
  const io = clientBlobIO(mc(c), transport(ctx));
  const mine = await createPointerMessage(io, ctx.key, ctx.acct.accountId, hooks[0]!, backendsOf(ctx)());
  v = await vault(ctx).update((x) => {
    x.pointer ??= mine;
    return x;
  });
  // Another device won the race: drop ours.
  if (v.pointer!.messageId !== mine.messageId) await mc(c).backend(mine.webhookId).slot.remove?.(mine.messageId).catch(() => {});
  return v.pointer!;
}

const schedulers = new WeakMap<DriveClient, SnapshotScheduler>();
const copiers = new WeakMap<DriveClient, SafeCopier>();

// ── channels ─────────────────────
const sqlOf = (ctx: ModeCtx) => (ctx.store instanceof SqlIndexStore ? ctx.store : null);
const chains = new WeakMap<ModeCtx, ChainIndex>();
const chainOf = (ctx: ModeCtx) => {
  let c = chains.get(ctx);
  if (!c) {
    const s = sqlOf(ctx);
    // Kept in the local index database (main tab); a secondary tab keeps it in memory.
    c = new ChainIndex(
      s
        ? {
            get: () => s.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'chain_index'", [])?.v ?? null,
            set: (v) => void s.sql.run("INSERT INTO meta (k, v) VALUES ('chain_index', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [v]),
          }
        : undefined,
    );
    chains.set(ctx, c);
  }
  return c;
};
const movers = new WeakMap<DriveClient, ChannelMover>();
/** The decrypted log (the drain reads relocate entries). */
const this_arbiter = (ctx: ModeCtx) => new EncryptedArbiter(new OpCodec(ctx.key, ctx.acct.accountId), ctx.http);
function mover(ctx: ModeCtx, c: DriveClient): ChannelMover {
  let m = movers.get(c);
  const s = sqlOf(ctx);
  if (!s) throw new Error("main_tab_only: moving a channel runs in the main tab (it keeps its progress in the local database)");
  if (!m) movers.set(c, (m = new ChannelMover({ client: mc(c), store: s, vault: vault(ctx), key: ctx.key, accountId: ctx.acct.accountId, transport: transport(ctx), log: this_arbiter(ctx) })));
  return m;
}
/**
 * Which channels hold snapshot data. Reading the pointer is a Discord GET, so the answer is kept for
 * CRITICAL_TTL_MS per pointer message (it only changes with new segments, which go to the pointer's own
 * channel, or with a move, which drops the cache).
 */
const CRITICAL_TTL_MS = 5 * 60_000;
const critCache = new WeakMap<ModeCtx, { key: string; at: number; v: { what: Map<string, ("pointer" | "snapshots")[]>; bytes: Map<string, number> } }>();
async function critical(ctx: ModeCtx, c: DriveClient, fresh = false) {
  const v = await vault(ctx).load();
  const key = v.pointer ? `${v.pointer.webhookId}/${v.pointer.messageId}` : "";
  const hit = critCache.get(ctx);
  if (!fresh && hit && hit.key === key && Date.now() - hit.at < CRITICAL_TTL_MS) return hit.v;
  const r = await chainOf(ctx)
    .hooks(clientBlobIO(mc(c), transport(ctx)), ctx.key, ctx.acct.accountId, v)
    .catch(() => ({ what: new Map<string, ("pointer" | "snapshots")[]>(v.pointer ? [[v.pointer.webhookId, ["pointer"]]] : []), bytes: new Map<string, number>() }));
  critCache.set(ctx, { key, at: Date.now(), v: r });
  return r;
}

export const mode: ModeImpl = {
  mode: "metadata-only",
  marker: MODE_MARKER,
  clientSnapshots: true,
  serverFeatures: { thumbnails: false, search: false, streaming: false },

  arbiter(ctx) {
    return ctx.timed(new EncryptedArbiter(new OpCodec(ctx.key, ctx.acct.accountId), ctx.http));
  },

  async client(ctx) {
    const hooks = toWebhookRefs(await vault(ctx).load());
    return new MetadataClient({
      device: { id: ctx.acct.deviceId, name: ctx.acct.deviceName },
      arbiter: this.arbiter(ctx),
      transport: transport(ctx),
      webhooks: hooks.length ? hooks : [{ id: "0", url: "unset://" }],
      store: ctx.store,
      net: ctx.net,
      resume: ctx.resume,
    });
  },

  async channels(ctx, c) {
    const v = await vault(ctx).load();
    const s = sqlOf(ctx);
    const stats = s?.locationStats() ?? new Map<string, { files: number; bytes: number }>();
    const crit = c ? await critical(ctx, c) : { what: new Map<string, ("pointer" | "snapshots")[]>(), bytes: new Map<string, number>() };
    const unav = s ? s.unavailable() : [];
    const rows: ChannelRow[] = v.webhooks
      .filter((w) => !w.drain)
      .map((w) => {
        const st = stats.get(w.id) ?? { files: 0, bytes: 0 };
        const what = crit.what.get(w.id) ?? [];
        return { id: w.id, channelId: w.channelId, label: w.label, retired: !!w.retired, critical: what.length > 0, criticalWhat: what, files: st.files, bytes: st.bytes + (crit.bytes.get(w.id) ?? 0), dependent: st.files };
      });
    const m = c && s ? (movers.get(c)?.state() ?? (s.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'channel_move'", [])?.v ? (JSON.parse(s.sql.get<{ v: string }>("SELECT v FROM meta WHERE k = 'channel_move'", [])!.v) as MoveStatus) : null)) : null;
    return {
      webhooks: rows,
      advice: vaultAdvice(v),
      removed: (v.removed ?? []).map((r) => ({ ...r, unavailableFiles: unav.filter((u) => u.locs.includes(r.id)).length })),
      move: m,
    };
  },

  async addChannel(ctx, url) {
    const w = await inspectForVault(transport(ctx), url);
    await vault(ctx).addWebhook(w);
  },

  async removalImpact(ctx, c, id) {
    const v = await vault(ctx).load();
    const w = v.webhooks.find((x) => x.id === id);
    if (!w) throw new Error("no_such_channel");
    const s = sqlOf(ctx);
    const at = s ? s.filesAt(id, 1000) : { total: 0, bytes: 0, rows: [] };
    const crit = await critical(ctx, c, true);
    const what = crit.what.get(id) ?? [];
    const others = v.webhooks.filter((x) => x.id !== id && !x.retired && !x.drain).length;
    const pieceBytes = s?.locationStats().get(id)?.bytes ?? 0;
    const moveBytes = pieceBytes + (crit.bytes.get(id) ?? 0);
    const impact: RemovalImpact = {
      webhookId: id,
      label: w.label,
      critical: what.length > 0,
      criticalWhat: what,
      files: at.total,
      bytes: at.bytes,
      list: at.rows,
      more: Math.max(0, at.total - at.rows.length),
      otherActive: others,
      moveBytes,
      moveEtaMs: estimateMs(moveBytes, others),
      retired: !!w.retired,
      checking: s ? s.versionsWithoutPieces(10_000).length : 0,
      last: others === 0,
    };
    return impact;
  },

  async channelFileIds(ctx, _c, id) {
    const s = sqlOf(ctx);
    if (!s) return [];
    const out: string[] = [];
    for (let after = ""; ; ) {
      const b = s.versionsAt(id, after, 5000);
      if (!b.length) return out;
      out.push(...b.map((x) => x.nodeId));
      after = b.at(-1)!.uploadId;
    }
  },

  async retireChannel(ctx, id, retired) {
    const v = await vault(ctx).load();
    const w = v.webhooks.find((x) => x.id === id);
    if (!w || w.drain) throw new Error("no_such_channel");
    if (retired) {
      if (v.pointer?.webhookId === id || (critCache.get(ctx)?.v.what.get(id)?.length ?? 0) > 0) throw new Error("channel_critical");
      if (!v.webhooks.some((x) => x.id !== id && !x.retired && !x.drain)) throw new Error("need_other_channel");
    }
    await vault(ctx).setRetired(id, retired);
  },

  async moveChannel(ctx, c, id, onProgress) {
    const r = await mover(ctx, c).run(id, onProgress);
    critCache.delete(ctx);
    return r;
  },

  async moveStatus(ctx, c) {
    const s = sqlOf(ctx);
    return s ? mover(ctx, c).state() : null;
  },

  async removeChannel(ctx, id, c?: DriveClient) {
    const v = await vault(ctx).load();
    const w = v.webhooks.find((x) => x.id === id);
    if (!w) throw new Error("no_such_channel");
    if (w.drain) throw new Error("channel_draining");
    if (!v.webhooks.some((x) => x.id !== id && !x.retired && !x.drain)) throw new Error("need_other_channel");
    const crit = c ? (await critical(ctx, c, true)).what.get(id) : v.pointer?.webhookId === id ? ["pointer"] : [];
    if (crit?.length) throw new Error("channel_critical");
    await vault(ctx).removeWebhook(id, "removed");
    const s = sqlOf(ctx);
    if (s) refreshUnavailable(s, await vault(ctx).load());
  },

  async upkeep(ctx, c) {
    const s = sqlOf(ctx);
    if (s) await backfillPieces(mc(c), s, 50);
  },

  async unavailable(ctx) {
    const s = sqlOf(ctx);
    if (!s) return [];
    return refreshUnavailable(s, await vault(ctx).load());
  },

  async discordUsage(ctx, c) {
    const s = sqlOf(ctx);
    if (!s) return null;
    const crit = await critical(ctx, c);
    return s.storageTotals().pieceBytes + [...crit.bytes.values()].reduce((a, b) => a + b, 0);
  },

  async rescueKit(ctx, c) {
    const ptr = await ensurePointer(ctx, c);
    const v = await vault(ctx).load();
    const list = backendDescriptors(v);
    if (!list.some((b) => b.id === ptr.webhookId)) throw new Error("pointer_hook_gone: the pointer message channel was removed from the vault");
    // The pointer gets the current backend list now (not only at the next snapshot): the kit shown below
    // must restore every channel even if no snapshot is written before the disaster.
    const io = clientBlobIO(mc(c), transport(ctx));
    const p = await readPtr(io, ctx.key, ctx.acct.accountId, ptr);
    if ((p.vaultRevision ?? -1) < vault(ctx).revision || !sameBackends(p.backends, list)) {
      await writePointer(io, ctx.key, ctx.acct.accountId, ptr, { ...p, backends: list, vaultRevision: vault(ctx).revision, writtenAt: Date.now() }, "same_coverage");
    }
    return makeRescueKit(ctx.acct.accountId, ctx.acct.accountKey, ptr, list);
  },

  kitVersion: 3,

  async kitOutdated(ctx, savedFormat) {
    // A kit made before format 3 names one webhook. With more than one channel the restore needs the
    // pointer's list too; a pointer written by a current client has it, but a fresh kit is safer.
    return (savedFormat ?? 1) < 3 && activeBackends(await vault(ctx).load()) > 1;
  },

  decodeKit(text) {
    const k = openRescueKit(text);
    return { accountId: k.accountId, key: k.key, format: k.v };
  },

  async snapshotTick(ctx, c, force) {
    if (!ctx.leader()) return null;
    const v = await vault(ctx).load();
    if (!v.pointer) return null;
    let s = schedulers.get(c);
    if (!s) {
      // Phones (metered) write only segments, bases come from desktops.
      const nav = (globalThis as unknown as { navigator?: { userAgent?: string; connection?: { type?: string; saveData?: boolean } } }).navigator;
      const metered = /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? "") || nav?.connection?.type === "cellular" || !!nav?.connection?.saveData;
      // Snapshot objects only on the pointer's channel: one critical
      // channel instead of all of them; the others can be retired or removed freely.
      const ptrHook = v.pointer.webhookId;
      s = new SnapshotScheduler({
        io: { ...clientBlobIO(mc(c), transport(ctx)), post: (d, f) => mc(c).postBlobTo(ptrHook, d, f) },
        backends: backendsOf(ctx),
        key: ctx.key,
        accountId: ctx.acct.accountId,
        pointer: v.pointer,
        log: ctx.http,
        store: ctx.store,
        now: () => Date.now(),
        isPrimary: () => ctx.leader(),
        unmetered: () => !metered,
        serverTimeOf: (seq) => ctx.serverTimeOf(seq),
      });
      schedulers.set(c, s);
    }
    const r = await s.tick(force);
    // The Safe's slot copied next to the chain (and put back when the instance lost it): see safe-copy.ts.
    let cp = copiers.get(c);
    if (!cp) {
      const ptr = v.pointer;
      const at = () => vault(ctx).cached?.content.pointer ?? ptr;
      // Copies go to the pointer's channel, like the chain (one critical channel).
      cp = new SafeCopier({ io: { ...clientBlobIO(mc(c), transport(ctx)), post: (d, f) => mc(c).postBlobTo(at().webhookId, d, f) }, key: ctx.key, accountId: ctx.acct.accountId, pointer: at, api: ctx.http, now: () => Date.now() });
      copiers.set(c, cp);
    }
    await cp.tick(force).catch(() => null);
    return r ? { kind: r.kind, written: r.written, toSeq: r.pointer.toSeq } : null;
  },

  cleanup(ctx, c, cc) {
    const cleaner = new Cleaner({
      client: c,
      log: this.arbiter(ctx),
      api: ctx.http.gc(),
      transport: transport(ctx),
      webhook: (id) => mc(c).webhook(id),
      backend: (id) => mc(c).backend(id),
      removedHook: (id) => !mc(c).registry.has(id),
      pointer: async () => {
        const v = await vault(ctx).load();
        return v.pointer ? readPtr(clientBlobIO(mc(c), transport(ctx)), ctx.key, ctx.acct.accountId, v.pointer) : null;
      },
      isPrimary: () => cc.primary(),
      metered: () => cc.metered(),
    });
    // Channels moved away (drain): after the retention their old messages go
    // and the webhook leaves the vault. Same gates as the fragment step (main tab, unmetered, or manual).
    const drains = async (manual: boolean) => {
      if (!manual && (!cc.primary() || cc.metered())) return;
      const v = await vault(ctx).load();
      const due = v.webhooks.filter((w) => w.drain);
      if (!due.length) return;
      const now = (await ctx.http.gc().status()).now;
      const p = v.pointer ? await readPtr(clientBlobIO(mc(c), transport(ctx)), ctx.key, ctx.acct.accountId, v.pointer).catch(() => null) : null;
      const bases = p ? [p.base, ...(p.history ?? [])].filter((b) => !!b).map((b) => b!.headSeq) : [];
      const oldest = bases.length ? Math.min(...bases) : Infinity;
      for (const w of due) await finishDrain({ client: mc(c), vault: vault(ctx), log: this_arbiter(ctx), transport: transport(ctx), key: ctx.key, accountId: ctx.acct.accountId }, w, now, oldest).catch(() => null);
    };
    return {
      async status() {
        const p = await cleaner.preview();
        return { by: "client", lastRunAt: p.lastRunAt, expired: p.expired, waiting: p.waiting, due: p.deletable, dueBytes: p.deletableBytes, nextAt: p.nextAt };
      },
      run: async (manual) => {
        const r = await cleaner.run(manual);
        await drains(manual);
        return r;
      },
    };
  },

  async shareAttachments(ctx, c, manifestRef) {
    const prep = await prepareShare({ transport: transport(ctx), hook: (id) => mc(c).webhook(id), loadManifest: (ref) => c.loadManifest(ref) }, manifestRef, { name: "", size: 0, sha256: "" });
    return prep.attachments;
  },
};
