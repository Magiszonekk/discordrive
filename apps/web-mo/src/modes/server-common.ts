// Shared by the e2ee and plain browser modes: channels and share addresses come from the
// instance (it holds the webhooks and named the attachments). Never imported by metadata only.
import { REQUIRED_CHANNELS, RECOMMENDED_CHANNELS, purgeExpiredTrash, releasedUploads, type Placement, type DriveClient, type ShareAttachment } from "@ddv4/metadata-client";
import { expiredTrash, inTrash } from "@ddv4/sync-core";
import type { ChannelRow, ChannelsView, CleanupCtx, ModeCleanup, ModeCtx, MoveStatus, RemovalImpact, RemovedChannel, StorageStatus } from "./types.js";

interface ServerChannelsBody {
  own: (Omit<ChannelRow, "retired" | "critical" | "criticalWhat" | "files" | "bytes" | "dependent"> & Partial<ChannelRow>)[];
  pool: { channels: number; alive: number };
  using: "own" | "pool" | "none";
  removed?: RemovedChannel[];
  move?: MoveStatus | null;
  botRecovery?: boolean;
  usage?: number;
}

/** Channels as the instance reports them (GET /v1/channels): own channels or the pool. */
export async function serverChannels(ctx: ModeCtx): Promise<ChannelsView> {
  const r = await ctx.http.json<ServerChannelsBody>("GET", "/v1/channels");
  const own = r.body.own;
  // Advice counts the channels that take new fragments (a retired one only keeps what it has).
  const active = own.filter((w) => !w.retired);
  const chans = new Set(active.map((w) => w.channelId)).size;
  const n = r.body.using === "own" ? chans : r.body.using === "pool" ? r.body.pool.channels : 0;
  const shared = r.body.using === "own" ? [...new Set(active.map((w) => w.channelId))].filter((c) => active.filter((w) => w.channelId === c).length > 1) : [];
  return {
    webhooks: own.map((w) => ({
      id: w.id,
      channelId: w.channelId,
      label: w.label,
      alive: w.alive,
      retired: w.retired ?? false,
      critical: w.critical ?? false,
      criticalWhat: w.criticalWhat ?? [],
      files: w.files ?? 0,
      bytes: w.bytes ?? 0,
      dependent: w.dependent ?? w.files ?? 0,
    })),
    removed: r.body.removed ?? [],
    move: r.body.move ?? null,
    botRecovery: r.body.botRecovery ?? false,
    pool: r.body.pool,
    using: r.body.using,
    advice: { ok: n >= REQUIRED_CHANNELS, channels: n, suggestMore: n < RECOMMENDED_CHANNELS && r.body.using === "own", sharedChannels: shared },
  };
}

/** Most names listed in the remove dialog (RemovalImpact.list). */
export const IMPACT_LIST_MAX = 1000;

/**
 * The remove dialog: the instance knows which uploads have blobs on the channel, only this
 * client knows their names (e2ee: the tree is encrypted for the server), so the upload IDs are
 * mapped here: upload → bound version's node → name, size, trashed (node or an ancestor).
 */
export async function serverRemovalImpact(ctx: ModeCtx, client: DriveClient, id: string): Promise<RemovalImpact> {
  const r = await ctx.http.json<Omit<RemovalImpact, "list" | "more"> & { uploads: string[]; more: number }>("GET", `/v1/channels/${id}/impact`);
  const b = r.body;
  const list: RemovalImpact["list"] = [];
  for (const u of b.uploads) {
    const nodeId = client.store.getUpload(u)?.boundTo?.nodeId;
    const n = nodeId ? client.store.getNode(nodeId) : undefined;
    // Not in this replica (yet): a final upload whose commit is on its way, or a released version.
    if (!n || n.kind !== "file") continue;
    if (list.length < IMPACT_LIST_MAX) list.push({ id: n.id, name: n.name, size: n.content?.sizeBytes ?? 0, trashed: inTrash(client.store, n.id) });
  }
  list.sort((x, y) => Number(x.trashed) - Number(y.trashed) || x.name.localeCompare(y.name));
  return {
    webhookId: b.webhookId,
    label: b.label,
    critical: b.critical,
    criticalWhat: b.criticalWhat,
    files: b.files,
    bytes: b.bytes,
    list,
    // Files not shown by name: past the list limit, past the server's cut-off, or not in this replica yet.
    more: Math.max(0, b.files - list.length),
    otherActive: b.otherActive,
    moveBytes: b.moveBytes,
    moveEtaMs: b.moveEtaMs,
    retired: b.retired,
  };
}

/** Node IDs of every file with a blob on the channel (upload IDs from the instance, mapped here). */
export async function serverChannelFileIds(ctx: ModeCtx, client: DriveClient, id: string): Promise<string[]> {
  const r = await ctx.http.json<{ uploads: string[] }>("GET", `/v1/channels/${id}/impact`);
  return r.body.uploads.map((u) => client.store.getUpload(u)?.boundTo?.nodeId).filter((x): x is string => !!x);
}

export async function serverRetireChannel(ctx: ModeCtx, id: string, retired: boolean): Promise<void> {
  await ctx.http.json("POST", `/v1/channels/${id}/retire`, { retired });
}

/** Option 2 on the instance: the job runs there (no tab needed); poll serverMoveStatus. */
export async function serverMoveChannel(ctx: ModeCtx, id: string, onProgress?: (s: MoveStatus) => void): Promise<MoveStatus> {
  const r = await ctx.http.json<{ move: MoveStatus }>("POST", `/v1/channels/${id}/move`, {});
  onProgress?.(r.body.move);
  return r.body.move;
}

export async function serverMoveStatus(ctx: ModeCtx): Promise<MoveStatus | null> {
  return (await ctx.http.json<{ move: MoveStatus | null }>("GET", "/v1/channels/move")).body.move;
}

/** Option 3: remove anyway (the instance refuses a critical channel or the last place to post to). */
export async function serverRemoveChannel(ctx: ModeCtx, id: string): Promise<void> {
  await ctx.http.json("DELETE", `/v1/channels/${id}`);
}

export async function serverRecoverWithBot(ctx: ModeCtx, id: string): Promise<MoveStatus> {
  return (await ctx.http.json<{ move: MoveStatus }>("POST", `/v1/channels/${id}/recover`, {})).body.move;
}

export async function serverUnavailable(ctx: ModeCtx): Promise<{ uploadId: string; webhookIds: string[] }[]> {
  return (await ctx.http.json<{ uploads: { uploadId: string; webhookIds: string[] }[] }>("GET", "/v1/channels/unavailable")).body.uploads;
}

export async function serverDiscordUsage(ctx: ModeCtx): Promise<number | null> {
  return (await ctx.http.json<{ bytes: number }>("GET", "/v1/usage")).body.bytes;
}

/** Attachment addresses of a version from the instance (it named the attachments). */
export async function serverShareAttachments(ctx: ModeCtx, c: DriveClient, manifestRef: string, decode: (ref: string) => { at: Placement }): Promise<ShareAttachment[]> {
  const { manifest } = await c.loadManifest(manifestRef);
  const ids = [decode(manifestRef).at.attachmentId, ...[...manifest.chunks].sort((a, b) => a.index - b.index).map((ch) => (ch.placements?.[0] as Placement).attachmentId)];
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
