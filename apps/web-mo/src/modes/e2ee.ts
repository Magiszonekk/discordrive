// e2ee mode of the browser app (docs/stage3-modes.md): contents and names encrypted here like
// in metadata only, but the blobs go through the instance, which knows the webhooks (pool +
// the account's own channels) and does the background work (snapshots, cleanup). The browser
// never sees a webhook URL after pasting one in Settings; the rescue kit has no webhook.
import {
  EncryptedArbiter,
  OpCodec,
  DriveClient,
  decodeManifestRef,
  decodeServerRescueKit,
  encodeServerRescueKit,
  REQUIRED_CHANNELS,
  RECOMMENDED_CHANNELS,
  type DiscordPlacement,
  type ShareAttachment,
} from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import type { ChannelsView, ModeCtx, ModeImpl } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:e2ee";

/** Channels as the instance reports them (GET /v1/channels): own channels or the pool. */
export async function serverChannels(ctx: ModeCtx): Promise<ChannelsView> {
  const r = await ctx.http.json<{ own: { id: string; channelId: string; label: string; alive: boolean }[]; pool: { channels: number; alive: number }; using: "own" | "pool" | "none" }>("GET", "/v1/channels");
  const own = r.body.own;
  const chans = new Set(own.map((w) => w.channelId)).size;
  const n = r.body.using === "own" ? chans : r.body.using === "pool" ? r.body.pool.channels : 0;
  const shared = r.body.using === "own" ? [...new Set(own.map((w) => w.channelId))].filter((c) => own.filter((w) => w.channelId === c).length > 1) : [];
  return {
    webhooks: own,
    pool: r.body.pool,
    using: r.body.using,
    advice: { ok: n >= REQUIRED_CHANNELS, channels: n, suggestMore: n < RECOMMENDED_CHANNELS && r.body.using === "own", sharedChannels: shared },
  };
}

/** Attachment addresses of a version from the instance (it named the attachments). */
export async function serverShareAttachments(ctx: ModeCtx, c: DriveClient, manifestRef: string, decode: (ref: string) => { at: DiscordPlacement }): Promise<ShareAttachment[]> {
  const { manifest } = await c.loadManifest(manifestRef);
  const ids = [decode(manifestRef).at.attachmentId, ...[...manifest.chunks].sort((a, b) => a.index - b.index).map((ch) => (ch.placements?.[0] as DiscordPlacement).attachmentId)];
  const r = await ctx.http.json<{ attachments: ShareAttachment[] }>("POST", "/v1/blobs/describe", { attachmentIds: ids });
  return r.body.attachments;
}

export const mode: ModeImpl = {
  mode: "e2ee",
  marker: MODE_MARKER,
  clientSnapshots: false,

  arbiter(ctx) {
    return ctx.timed(new EncryptedArbiter(new OpCodec(ctx.key, ctx.acct.accountId), ctx.http));
  },

  async client(ctx) {
    return new DriveClient({
      device: { id: ctx.acct.deviceId, name: ctx.acct.deviceName },
      arbiter: this.arbiter(ctx),
      blobs: new ServerBlobStore(ctx.http),
      store: ctx.store,
    });
  },

  channels: serverChannels,

  async addChannel(ctx, url) {
    await ctx.http.json("POST", "/v1/channels", { url: url.trim() });
  },

  async removeChannel(ctx, id) {
    await ctx.http.json("DELETE", `/v1/channels/${id}`);
  },

  async rescueKit(ctx) {
    return encodeServerRescueKit({ v: 2, accountId: ctx.acct.accountId, key: ctx.acct.accountKey, server: ctx.acct.serverUrl });
  },

  decodeKit(text) {
    const k = decodeServerRescueKit(text);
    return { accountId: k.accountId, key: k.key };
  },

  async shareAttachments(ctx, c, manifestRef) {
    return serverShareAttachments(ctx, c, manifestRef, decodeManifestRef);
  },
};
