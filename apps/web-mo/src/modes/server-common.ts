// Shared by the e2ee and plain browser modes: channels and share addresses come from the
// instance (it holds the webhooks and named the attachments). Never imported by metadata only.
import { REQUIRED_CHANNELS, RECOMMENDED_CHANNELS, purgeExpiredTrash, releasedUploads, type DiscordPlacement, type DriveClient, type ShareAttachment } from "@ddv4/metadata-client";
import { expiredTrash } from "@ddv4/sync-core";
import type { ChannelsView, CleanupCtx, ModeCleanup, ModeCtx, StorageStatus } from "./types.js";

/** Channels as the instance reports them (GET /v1/channels): own channels or the pool. */
export async function serverChannels(ctx: ModeCtx): Promise<ChannelsView> {
  const r = await ctx.http.json<{ own: { id: string; channelId: string; label: string; alive: boolean }[]; pool: { channels: number; alive: number }; using: "own" | "pool" | "none" }>("GET", "/v1/channels");
  const own = r.body.own;
  const chans = new Set(own.map((w) => w.channelId)).size;
  const n = r.body.using === "own" ? chans : r.body.using === "pool" ? r.body.pool.channels : 0;
  const shared = r.body.using === "own" ? [...new Set(own.map((w) => w.channelId))].filter((c) => own.filter((w) => w.channelId === c).length > 1) : [];
  return {
    webhooks: own.map((w) => ({ ...w, retired: false, critical: false, criticalWhat: [], files: 0, bytes: 0, dependent: 0 })),
    removed: [],
    move: null,
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


interface ServerGc {
  now: number;
  lastRunAt: number | null;
  waiting: number;
  waitingBytes: number;
  due: number;
  deletedUploads: number;
  nextAt: number | null;
}

/**
 * e2ee/plain: the instance deletes fragments in the background (30 days after a release). The
 * client still does the trash step (Q4; the server cannot write operations in e2ee) and tells the
 * instance which uploads its index released (POST /v1/uploads/released, idempotent).
 */
export function serverCleanup(ctx: ModeCtx, client: DriveClient, cc: CleanupCtx): ModeCleanup {
  let reportedUpTo = 0;
  const report = async () => {
    const list = releasedUploads(client.store, reportedUpTo);
    for (let i = 0; i < list.length; i += 1000) await ctx.http.json("POST", "/v1/uploads/released", { uploads: list.slice(i, i + 1000).map(({ uploadId, at }) => ({ uploadId, at })) });
    if (list.length) reportedUpTo = list.at(-1)!.seq;
  };
  const gc = async () => (await ctx.http.json<ServerGc>("GET", "/v1/gc")).body;
  return {
    async status(): Promise<StorageStatus> {
      const g = await gc();
      return { by: "server", lastRunAt: g.lastRunAt, expired: expiredTrash(client.store, g.now).length, waiting: g.waiting - g.due, due: g.due, dueBytes: g.waitingBytes, nextAt: g.nextAt };
    },
    async run(manual) {
      await client.pull();
      const before = await gc();
      const t = await purgeExpiredTrash(client, { now: before.now, lastRunAt: null, firstEntryAt: null }, { primary: cc.primary(), metered: cc.metered(), manual });
      await report();
      if (!manual) return { ...t, uploads: 0, messages: 0, bytes: 0, left: 0 };
      const after = (await ctx.http.json<ServerGc>("POST", "/v1/gc/run", {})).body;
      return { ...t, uploads: after.deletedUploads - before.deletedUploads, messages: 0, bytes: Math.max(0, before.waitingBytes - after.waitingBytes), left: after.due };
    },
  };
}
