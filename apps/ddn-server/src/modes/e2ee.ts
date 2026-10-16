// e2ee instance: the server knows the webhooks (pool from setup +
// account channels, sealed with instance.key) and moves the encrypted blobs; snapshots,
// cleanup and link refreshing run here without a browser tab.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiscordWebhookTransport } from "@ddv4/metadata-client";
import { INSTANCE_KEY_FILE, InstanceHooks, POOL, loadInstanceKey, serverBlobsMode } from "@ddv4/server-discord";
import type { ServerMode } from "./types.js";

export const MODE_MARKER = "ddn-mode-marker:e2ee";

export const serverMode: ServerMode = {
  mode: "e2ee",
  marker: MODE_MARKER,
  parts(c, ctx) {
    const m = serverBlobsMode({ dataDir: c.dataDir, bot: ctx.bot, discordApiOrigin: c.testing?.discordApiOrigin, log: ctx.log, transferLogsAll: c.transferLogs === true });
    return {
      extensions: [
        ...m.extensions,
        // The webhook vault belongs to metadata only: here the instance holds the webhooks.
        { name: "no-vault", route: async (r) => (r.path === "/v1/vault" ? (r.send(404, { error: "not_in_this_mode" }), true) : false) },
      ],
      // Always through the instance (it uses the bot when there is one): a share made before a
      // channel move holds the old attachment IDs, which only the instance resolves (s_blob_alias).
      shareRefresher: m.shareRefresher,
    };
  },
  async doctor(c, t) {
    if (!existsSync(join(c.dataDir, "ddn.db"))) return [{ level: "warn", what: t("d.pool"), detail: t("d.poolNone") }];
    const db = new DatabaseSync(join(c.dataDir, "ddn.db"));
    try {
      const pool = new InstanceHooks(db, loadInstanceKey(join(c.dataDir, INSTANCE_KEY_FILE), false)).list(POOL);
      const n = new Set(pool.map((h) => h.channelId)).size;
      return [{ level: n ? "ok" : "warn", what: t("d.pool"), detail: n ? t("d.poolOk", { n, alive: pool.filter((h) => h.alive).length }) : t("d.poolNone") }];
    } catch (e) {
      return [{ level: "fail", what: t("d.pool"), detail: (e as Error).message }];
    } finally {
      db.close();
    }
  },
  async addPoolWebhooks(c, urls) {
    const db = new DatabaseSync(join(c.dataDir, "ddn.db"));
    try {
      const hooks = new InstanceHooks(db, loadInstanceKey(join(c.dataDir, INSTANCE_KEY_FILE)));
      const t = new DiscordWebhookTransport({ apiOrigin: c.testing?.discordApiOrigin });
      for (const u of urls) await hooks.add(POOL, u, t);
      const pool = hooks.list(POOL);
      return { channels: new Set(pool.map((h) => h.channelId)).size, webhooks: pool.length };
    } finally {
      db.close();
    }
  },
};
