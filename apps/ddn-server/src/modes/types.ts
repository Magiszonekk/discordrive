// What a mode adds to the instance process. The instance loads
// apps/ddn-server/dist/<mode>/server-mode.mjs, built by build-server.ts from ONE of
// modes/<mode>.ts: a metadata-only instance never loads the server sender, an e2ee/plain one
// never loads what only another mode needs. Workspace packages stay external (one copy of
// DdnServer/HttpError in the process). Typechecking: every mode file against ServerMode.

import type { BotRefresher, ServerExtension } from "@ddv4/metadata-client/node";
import type { InstanceConfig } from "../config.js";

export interface ServerModeParts {
  extensions: ServerExtension[];
  /** Share-link refresher; null = shares only with the instance bot. */
  shareRefresher: BotRefresher | null;
}

export interface ServerModeCtx {
  bot: BotRefresher | null;
  log: (s: string) => void;
}

export interface ServerMode {
  readonly mode: InstanceConfig["mode"];
  readonly marker: string;
  /** Extra server parts for this instance (called once per server start). */
  parts(c: InstanceConfig, ctx: ServerModeCtx): ServerModeParts;
  /**
   * e2ee/plain: validate webhook URLs with Discord and store them in the instance pool
   * (sealed with instance.key). Setup calls it; URLs never go to the config file.
   */
  addPoolWebhooks?(c: InstanceConfig, urls: string[]): Promise<{ channels: number; webhooks: number }>;
  /** Extra `doctor` lines of this mode. `t` = the process's translator (a bundle must not carry its own i18n state). */
  doctor?(c: InstanceConfig, t: (key: string, params?: Record<string, string | number>) => string): Promise<{ level: "ok" | "warn" | "fail"; what: string; detail: string }[]>;
}
