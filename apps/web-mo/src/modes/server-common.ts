// Shared by the e2ee and plain browser modes: channels and share addresses come from the
// instance (it holds the webhooks and named the attachments). Never imported by metadata only.
import { REQUIRED_CHANNELS, RECOMMENDED_CHANNELS, type DiscordPlacement, type DriveClient, type ShareAttachment } from "@ddv4/metadata-client";
import type { ChannelsView, ModeCtx } from "./types.js";

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

