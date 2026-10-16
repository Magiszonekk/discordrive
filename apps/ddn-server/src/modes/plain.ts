// plain instance: e2ee + the server reads the operation log
// (names, tree, file keys): thumbnails and previews (ffmpeg, optional), server-side Range
// streaming and search by name. Same webhook pool / channels / background work as e2ee.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiscordWebhookTransport } from "@ddv4/metadata-client";
import { INSTANCE_KEY_FILE, InstanceHooks, POOL, loadInstanceKey, serverBlobsMode } from "@ddv4/server-discord";
import { PlainExtension, findFfmpeg } from "@ddv4/server-discord/plain";
import type { ServerMode } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:plain";

export const serverMode: ServerMode = {
  mode: "plain",
  marker: MODE_MARKER,
  parts(c, ctx) {
    const m = serverBlobsMode({ dataDir: c.dataDir, bot: ctx.bot, discordApiOrigin: c.testing?.discordApiOrigin, log: ctx.log, transferLogsAll: c.transferLogs === true });
    const plain = new PlainExtension({ dataDir: c.dataDir, blobs: m.blobs, log: ctx.log });
    return {
      extensions: [...m.extensions, plain, { name: "no-vault", route: async (r) => (r.path === "/v1/vault" ? (r.send(404, { error: "not_in_this_mode" }), true) : false) }],
      // Always through the instance (it uses the bot when there is one): a share made before a
      // channel move holds the old attachment IDs, which only the instance resolves (s_blob_alias).
      shareRefresher: m.shareRefresher,
    };
  },
  async doctor(c, t) {
    const out: { level: "ok" | "warn" | "fail"; what: string; detail: string }[] = [];
    const ff = findFfmpeg();
    out.push(ff ? { level: "ok", what: t("d.ffmpeg"), detail: t("d.ffmpegOk", { bin: ff.ffmpeg }) } : { level: "warn", what: t("d.ffmpeg"), detail: t(process.platform === "win32" ? "d.ffmpegMissingWin" : process.platform === "darwin" ? "d.ffmpegMissingMac" : "d.ffmpegMissingLinux") });
    if (!existsSync(join(c.dataDir, "ddn.db"))) return [...out, { level: "warn", what: t("d.pool"), detail: t("d.poolNone") }];
    const db = new DatabaseSync(join(c.dataDir, "ddn.db"));
    try {
      const pool = new InstanceHooks(db, loadInstanceKey(join(c.dataDir, INSTANCE_KEY_FILE), false)).list(POOL);
      const n = new Set(pool.map((h) => h.channelId)).size;
      out.push({ level: n ? "ok" : "warn", what: t("d.pool"), detail: n ? t("d.poolOk", { n, alive: pool.filter((h) => h.alive).length }) : t("d.poolNone") });
    } catch (e) {
      out.push({ level: "fail", what: t("d.pool"), detail: (e as Error).message });
    } finally {
      db.close();
    }
    return out;
  },
  async addPoolWebhooks(c, urls) {
    const db = new DatabaseSync(join(c.dataDir, "ddn.db"));
    try {
      const hooks = new InstanceHooks(db, loadInstanceKey(join(c.dataDir, INSTANCE_KEY_FILE)));
      const tr = new DiscordWebhookTransport({ apiOrigin: c.testing?.discordApiOrigin });
      for (const u of urls) await hooks.add(POOL, u, tr);
      const pool = hooks.list(POOL);
      return { channels: new Set(pool.map((h) => h.channelId)).size, webhooks: pool.length };
    } finally {
      db.close();
    }
  },
};
