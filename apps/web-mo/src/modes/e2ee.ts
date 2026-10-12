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
} from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { serverChannels, serverShareAttachments } from "./server-common.js";
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
