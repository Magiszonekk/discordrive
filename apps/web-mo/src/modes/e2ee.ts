// e2ee mode of the browser app: contents and names encrypted here like
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
} from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import {
  serverChannels,
  serverCleanup,
  serverDiscordUsage,
  serverMoveChannel,
  serverMoveStatus,
  serverRecoverWithBot,
  serverRemovalImpact,
  serverRemoveChannel,
  serverChannelFileIds,
  serverRetireChannel,
  serverShareAttachments,
  serverUnavailable,
} from "./server-common.js";
import type { ModeImpl } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:e2ee";

export const mode: ModeImpl = {
  mode: "e2ee",
  marker: MODE_MARKER,
  clientSnapshots: false,
  serverFeatures: { thumbnails: false, search: false, streaming: false },

  arbiter(ctx) {
    return ctx.timed(new EncryptedArbiter(new OpCodec(ctx.key, ctx.acct.accountId), ctx.http));
  },

  async client(ctx) {
    const blobs = new ServerBlobStore(ctx.http);
    // Upload concurrency follows the channels the instance posts this account's blobs to (own or the pool).
    blobs.channels = await serverChannels(ctx).then((v) => v.advice.channels).catch(() => 1);
    return new DriveClient({
      device: { id: ctx.acct.deviceId, name: ctx.acct.deviceName },
      arbiter: this.arbiter(ctx),
      blobs,
      store: ctx.store,
      net: ctx.net,
      resume: ctx.resume,
    });
  },

  channels: serverChannels,
  cleanup: serverCleanup,

  async addChannel(ctx, url) {
    await ctx.http.json("POST", "/v1/channels", { url: url.trim() });
  },

  // Removing a channel: the instance holds the webhooks and does
  // the work; a move runs there as a background job (no tab needed), names come from this index.
  async removeChannel(ctx, id) {
    await serverRemoveChannel(ctx, id);
  },
  removalImpact: serverRemovalImpact,
  channelFileIds: serverChannelFileIds,
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

  async shareAttachments(ctx, c, manifestRef) {
    return serverShareAttachments(ctx, c, manifestRef, decodeManifestRef);
  },
};
