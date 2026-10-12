// `discordrive serve`: one process for the API (/v1/...), the notify
// websocket (/v1/notify) and the built web app, from the same origin.
//
// Mode (koncept §2, docs/stage3-modes.md §2): the web app comes from apps/web-mo/dist/<mode>
// and the mode-specific server part from apps/ddn-server/dist/<mode>/server-mode.mjs, both
// built for exactly the configured mode (rebuilt when the sources changed). The server
// refuses to start when the bundle, the config and the database disagree on the mode.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DdnServer, DiscordBotRefresher, DISCORD_ORIGINS, type BotRefresher } from "@ddv4/metadata-client/node";
import { t } from "./i18n.js";
import { builtHash, sourceHash } from "../../web-mo/source-hash.js";
import { PACKAGE_DIR, POSIX_MODES, REPO_DIR, dbPath, originOf, webDir, type InstanceConfig } from "./config.js";
import { serverModeFile, serverModeState } from "../build-server.js";
import type { ServerMode } from "./modes/types.js";

export class ModeBuildError extends Error {}

/** Mode a web build was made for (dist/<mode>/build-stamp.json), or null. */
function builtMode(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "build-stamp.json"), "utf8")) as { mode?: string }).mode ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the web build of this mode missing or older than the sources? "stale" = dist/<mode> exists
 * but its build-stamp.json does not match the hash of the current sources (e.g. after
 * `git pull`) or the mode, or has no stamp at all.
 */
export function webBuildState(c: InstanceConfig): "ok" | "missing" | "stale" {
  const dir = webDir(c);
  if (!existsSync(join(dir, "index.html")) || !existsSync(join(dir, "ui.js"))) return "missing";
  // A custom webDir is someone else's build: never rebuild it.
  if (c.webDir) return "ok";
  return builtHash(dir) === sourceHash(REPO_DIR) && builtMode(dir) === c.mode ? "ok" : "stale";
}

function tsxArgs(script: string, ...rest: string[]): [string, string[]] {
  const tsxCli = createRequire(join(PACKAGE_DIR, "package.json")).resolve("tsx/cli");
  return [process.execPath, [tsxCli, script, ...rest]];
}
const webBuildArgs = (c: InstanceConfig) => tsxArgs(join(REPO_DIR, "apps", "web-mo", "build.ts"), c.mode);
const serverBuildArgs = (c: InstanceConfig) => tsxArgs(join(PACKAGE_DIR, "build-server.ts"), c.mode);

function runSync([cmd, args]: [string, string[]]): void {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], cwd: REPO_DIR });
  } catch (e) {
    throw new Error(String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" "));
  }
}

/** Build apps/web-mo/dist/<mode> and dist/<mode>/server-mode.mjs if missing or older than the sources. */
export function ensureWebBuilt(c: InstanceConfig, log: (s: string) => void = () => {}): string {
  const dir = webDir(c);
  const state = webBuildState(c);
  if (state !== "ok") {
    if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
    log(t(state === "stale" ? "s.rebuilding" : "s.building"));
    runSync(webBuildArgs(c));
  }
  if (serverModeState(c.mode) !== "ok") runSync(serverBuildArgs(c));
  return dir;
}

/** Async build (the setup spinner keeps turning while esbuild works). */
export async function buildWeb(c: InstanceConfig): Promise<string> {
  const dir = webDir(c);
  const run = async ([cmd, args]: [string, string[]]) => {
    try {
      await promisify(execFile)(cmd, args, { cwd: REPO_DIR });
    } catch (e) {
      throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-3).join(" "));
    }
  };
  if (webBuildState(c) !== "ok") {
    if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
    await run(webBuildArgs(c));
  }
  if (serverModeState(c.mode) !== "ok") await run(serverBuildArgs(c));
  return dir;
}

/** Load the mode bundle built for this instance; refuse one built for another mode. */
export async function loadServerMode(c: InstanceConfig): Promise<ServerMode> {
  const file = serverModeFile(c.mode);
  if (!existsSync(file)) throw new ModeBuildError(t("c.modeBuildMissing", { mode: c.mode }));
  const m = (await import(pathToFileURL(file).href)) as { serverMode?: ServerMode; MODE_MARKER?: string };
  if (!m.serverMode || m.serverMode.mode !== c.mode || m.MODE_MARKER !== `ddn-mode-marker:${c.mode}`) {
    throw new ModeBuildError(t("c.modeBuildMismatch", { built: String(m.serverMode?.mode), mode: c.mode }));
  }
  return m.serverMode;
}

export async function createServer(c: InstanceConfig, log: (s: string) => void = () => {}): Promise<DdnServer> {
  const test = c.testing?.discordApiOrigin;
  const dir = ensureWebBuilt(c, log);
  const mode = await loadServerMode(c);
  const bot: BotRefresher | null = c.botToken ? new DiscordBotRefresher(c.botToken, test) : null;
  const parts = mode.parts(c, { bot, log: (s) => console.error(`discordrive: ${s}`) });
  return new DdnServer({
    dbPath: dbPath(c),
    signup: c.signup,
    trustProxy: c.trustProxy,
    corsOrigins: [originOf(c.publicUrl)],
    limits: c.limits,
    mode: c.mode,
    language: c.language,
    extensions: parts.extensions,
    web: {
      dir,
      connectSrc: [...DISCORD_ORIGINS, ...(test ? [test] : [])],
      config: { serverUrl: originOf(c.publicUrl), language: c.language, mode: c.mode, ...(test ? { discordApiOrigin: test } : {}) },
    },
    bot: parts.shareRefresher ?? bot ?? undefined,
    cdnOrigins: test ? [test] : [],
  });
}

export async function serve(c: InstanceConfig, log: (s: string) => void = console.log): Promise<DdnServer> {
  // The build notice goes to stderr: it is shown even when the caller silences the usual log.
  const srv = await createServer(c, (s) => console.error(s));
  // Databases created before umask was set (older versions) are tightened here.
  if (POSIX_MODES) for (const f of [dbPath(c), `${dbPath(c)}-wal`, `${dbPath(c)}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  const { url } = await srv.listen(c.bind.port, c.bind.host);
  log(t("serve.log", { mode: c.mode, url, pub: c.publicUrl, signup: c.signup, share: srv.shares.available ? t("serve.yes") : t("serve.no") }));
  return srv;
}
