// Metadata-only mode of the browser app (koncept §3): webhooks in the encrypted vault, blobs
// straight to Discord, snapshots written by the main tab, rescue kit with the pointer webhook.
import {
  Cleaner,
  DiscordWebhookTransport,
  EncryptedArbiter,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  WebhookVault,
  clientBlobIO,
  createPointerMessage,
  decodeRescueKit,
  encodeRescueKit,
  inspectForVault,
  prepareShare,
  readPointer,
  toWebhookRefs,
  vaultAdvice,
  type DriveClient,
} from "@ddv4/metadata-client";
import type { ModeCtx, ModeImpl } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:metadata-only";

const transport = (ctx: ModeCtx) => new DiscordWebhookTransport({ apiOrigin: ctx.discordApiOrigin });
const vaults = new WeakMap<ModeCtx, WebhookVault>();
const vault = (ctx: ModeCtx) => {
  let v = vaults.get(ctx);
  if (!v) vaults.set(ctx, (v = new WebhookVault(ctx.http, ctx.key, ctx.acct.accountId)));
  return v;
};
const mc = (c: DriveClient) => c as MetadataClient;

async function ensurePointer(ctx: ModeCtx, c: DriveClient) {
  let v = await vault(ctx).load();
  if (v.pointer) return v.pointer;
  const hooks = toWebhookRefs(v);
  if (!hooks.length) throw new Error("need_channel: add a channel with a webhook first");
  const io = clientBlobIO(mc(c), transport(ctx));
  const mine = await createPointerMessage(io, ctx.key, ctx.acct.accountId, hooks[0]!);
  v = await vault(ctx).update((x) => {
    x.pointer ??= mine;
    return x;
  });
  // Another device won the race: drop ours.
  if (v.pointer!.messageId !== mine.messageId) await transport(ctx).deleteMessage(mc(c).webhook(mine.webhookId), mine.messageId).catch(() => {});
  return v.pointer!;
}

const schedulers = new WeakMap<DriveClient, SnapshotScheduler>();

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
    });
  },

  async channels(ctx) {
    const v = await vault(ctx).load();
    return { webhooks: v.webhooks.map((w) => ({ id: w.id, channelId: w.channelId, label: w.label })), advice: vaultAdvice(v) };
  },

  async addChannel(ctx, url) {
    const w = await inspectForVault(transport(ctx), url);
    await vault(ctx).addWebhook(w);
  },

  async rescueKit(ctx, c) {
    const ptr = await ensurePointer(ctx, c);
    const v = await vault(ctx).load();
    const hook = v.webhooks.find((w) => w.id === ptr.webhookId);
    if (!hook) throw new Error("pointer_hook_gone: the pointer message channel was removed from the vault");
    return encodeRescueKit({ v: 1, accountId: ctx.acct.accountId, key: ctx.acct.accountKey, webhookUrl: hook.url, pointerMessageId: ptr.messageId });
  },

  decodeKit(text) {
    const k = decodeRescueKit(text);
    return { accountId: k.accountId, key: k.key };
  },

  async snapshotTick(ctx, c, force) {
    if (!ctx.leader()) return null;
    const v = await vault(ctx).load();
    if (!v.pointer) return null;
    let s = schedulers.get(c);
    if (!s) {
      // §6.2: phones (metered) write only segments, bases come from desktops.
      const nav = (globalThis as unknown as { navigator?: { userAgent?: string; connection?: { type?: string; saveData?: boolean } } }).navigator;
      const metered = /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? "") || nav?.connection?.type === "cellular" || !!nav?.connection?.saveData;
      s = new SnapshotScheduler({
        io: clientBlobIO(mc(c), transport(ctx)),
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
    return r ? { kind: r.kind, written: r.written, toSeq: r.pointer.toSeq } : null;
  },

  cleanup(ctx, c, cc) {
    const cleaner = new Cleaner({
      client: c,
      log: this.arbiter(ctx),
      api: ctx.http.gc(),
      transport: transport(ctx),
      webhook: (id) => mc(c).webhook(id),
      pointer: async () => {
        const v = await vault(ctx).load();
        return v.pointer ? readPointer(clientBlobIO(mc(c), transport(ctx)), ctx.key, ctx.acct.accountId, v.pointer) : null;
      },
      isPrimary: () => cc.primary(),
      metered: () => cc.metered(),
    });
    return {
      async status() {
        const p = await cleaner.preview();
        return { by: "client", lastRunAt: p.lastRunAt, expired: p.expired, waiting: p.waiting, due: p.deletable, dueBytes: p.deletableBytes, nextAt: p.nextAt };
      },
      run: (manual) => cleaner.run(manual),
    };
  },

  async shareAttachments(ctx, c, manifestRef) {
    const prep = await prepareShare({ transport: transport(ctx), hook: (id) => mc(c).webhook(id), loadManifest: (ref) => c.loadManifest(ref) }, manifestRef, { name: "", size: 0, sha256: "" });
    return prep.attachments;
  },
};
