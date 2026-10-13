// Everything the e2ee instance adds to DdnServer, wired together (docs/stage3-modes.md):
// instance webhooks (pool + account channels, sealed with instance.key), the server sender,
// blobs through the instance, background cleanup and snapshots. Used by the e2ee server
// mode bundle (apps/ddn-server/src/modes/e2ee.ts) and by tests.

import { join } from "node:path";
import { ChannelPacer, DiscordWebhookTransport, type WebhookTransport } from "@ddv4/metadata-client";
import type { BotRefresher, ServerExtension } from "@ddv4/metadata-client/node";
import { BlobsExtension } from "./blobs-ext.js";
import { INSTANCE_KEY_FILE, InstanceHooks, loadInstanceKey } from "./instance-hooks.js";
import { DiscordSender } from "./sender.js";
import { SnapshotsExtension } from "./snapshots-ext.js";

export interface ServerBlobsModeOptions {
  dataDir: string;
  /** Instance bot (share links, faster link refresh); optional in e2ee. */
  bot?: BotRefresher | null;
  /** Tests: Discord API/CDN on a fake. */
  discordApiOrigin?: string;
  transport?: WebhookTransport;
  pacer?: ChannelPacer;
  log?: (s: string) => void;
  /** Background ticks (ms); 0 = off (tests drive tick() and blobs.moves()). */
  cleanupTickMs?: number;
  snapshotTickMs?: number;
  inflightBytes?: number;
}

export interface ServerBlobsMode {
  extensions: ServerExtension[];
  /** Share links: refresh through the bot, or the webhooks when there is none (§3.7). */
  shareRefresher: BotRefresher;
  hooks(): InstanceHooks;
  blobs: BlobsExtension;
  snapshots: SnapshotsExtension;
  sender: DiscordSender;
  instanceKey: Buffer;
}

export function serverBlobsMode(o: ServerBlobsModeOptions): ServerBlobsMode {
  const instanceKey = loadInstanceKey(join(o.dataDir, INSTANCE_KEY_FILE));
  const transport = o.transport ?? new DiscordWebhookTransport({ apiOrigin: o.discordApiOrigin });
  const sender = new DiscordSender({ transport, pacer: o.pacer });
  let hooks: InstanceHooks | null = null;
  const getHooks = () => {
    if (!hooks) throw new Error("instance webhooks not ready");
    return hooks;
  };
  const hooksExt: ServerExtension = {
    name: "instance-hooks",
    init: (srv) => {
      hooks = new InstanceHooks(srv.db, instanceKey, srv.clock);
    },
  };
  let snapshots: SnapshotsExtension | null = null;
  const blobs = new BlobsExtension({
    get hooks() {
      return getHooks();
    },
    snapshots: () => snapshots,
    sender,
    bot: o.bot ?? null,
    tickMs: o.cleanupTickMs,
    inflightBytes: o.inflightBytes,
    cdnOrigins: o.discordApiOrigin ? [o.discordApiOrigin] : [],
    log: o.log,
  } as never);
  snapshots = new SnapshotsExtension({ instanceKey, hooks: getHooks, sender, dataDir: o.dataDir, tickMs: o.snapshotTickMs, log: o.log });
  return { extensions: [hooksExt, blobs, snapshots], shareRefresher: blobs.shareRefresher(), hooks: getHooks, blobs, snapshots, sender, instanceKey };
}
