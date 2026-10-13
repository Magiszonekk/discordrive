// plain mode of the browser app (docs/stage3-modes.md §7): like e2ee (blobs through the
// instance, channels on the server, server-side background work), but the operations go to
// the server in clear (PlainOpCodec), so the server knows names and file keys: thumbnails,
// previews, Range streaming and search run on the server.
import { DriveClient, decodeManifestRef, decodeServerRescueKit, encodeServerRescueKit } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { PlainArbiter, PlainOpCodec } from "@ddv4/metadata-client/plain-ops";
import {
  serverChannels,
  serverCleanup,
  serverDiscordUsage,
  serverMoveChannel,
  serverMoveStatus,
  serverRecoverWithBot,
  serverRemovalImpact,
  serverRemoveChannel,
  serverRetireChannel,
  serverShareAttachments,
  serverUnavailable,
} from "./server-common.js";
import type { ModeImpl } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:plain";

export const mode: ModeImpl = {
  mode: "plain",
  marker: MODE_MARKER,
  clientSnapshots: false,
  serverFeatures: { thumbnails: true, search: true, streaming: true },

  arbiter(ctx) {
    return ctx.timed(new PlainArbiter(new PlainOpCodec(ctx.acct.accountId), ctx.http));
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
  cleanup: serverCleanup,

  async addChannel(ctx, url) {
    await ctx.http.json("POST", "/v1/channels", { url: url.trim() });
  },

  // Removing a channel (zlecenie 2026-10-13-webhooki p. 1): the instance holds the webhooks and does
  // the work; a move runs there as a background job (no tab needed), names come from this index.
  async removeChannel(ctx, id) {
    await serverRemoveChannel(ctx, id);
  },
  removalImpact: serverRemovalImpact,
  retireChannel: serverRetireChannel,
  async moveChannel(ctx, _client, id, onProgress) {
    return serverMoveChannel(ctx, id, onProgress);
  },
  async moveStatus(ctx) {
    return serverMoveStatus(ctx);
  },
  async recoverWithBot(ctx, _client, id) {
    return serverRecoverWithBot(ctx, id);
  },
  async unavailable(ctx) {
    return serverUnavailable(ctx);
  },
  async discordUsage(ctx) {
    return serverDiscordUsage(ctx);
  },

  async rescueKit(ctx) {
    return encodeServerRescueKit({ v: 2, accountId: ctx.acct.accountId, key: ctx.acct.accountKey, server: ctx.acct.serverUrl });
  },

  decodeKit(text) {
    const k = decodeServerRescueKit(text);
    return { accountId: k.accountId, key: k.key };
  },

  async thumbnail(ctx, nodeId) {
    const r = await ctx.http.request("GET", `/v1/plain/thumb/${nodeId}`);
    if (!r.ok) return null;
    return new Blob([await r.arrayBuffer()], { type: "image/jpeg" });
  },

  async search(ctx, q) {
    return (await ctx.http.json<{ hits: { id: string; name: string; kind: "file" | "folder"; parentId: string | null; size: number | null }[] }>("GET", `/v1/plain/search?q=${encodeURIComponent(q)}`)).body.hits;
  },

  async streamUrl(ctx, nodeId) {
    return (await ctx.http.json<{ url: string }>("POST", `/v1/plain/stream/${nodeId}`, {})).body.url;
  },

  async shareAttachments(ctx, c, manifestRef) {
    return serverShareAttachments(ctx, c, manifestRef, decodeManifestRef);
  },
};
