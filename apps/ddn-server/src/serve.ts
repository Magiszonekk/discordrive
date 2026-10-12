// `discordrive serve`: one process for the API (/v1/...), the notify
// websocket (/v1/notify) and the built web app, from the same origin.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DdnServer, DiscordBotRefresher, DISCORD_ORIGINS } from "@ddv4/metadata-client/node";
import { t } from "./i18n.js";
import { builtHash, sourceHash } from "../../web-mo/source-hash.js";
import { PACKAGE_DIR, POSIX_MODES, REPO_DIR, dbPath, originOf, webDir, type InstanceConfig } from "./config.js";

/**
 * Is the default web build missing or older than the sources? "stale" = dist exists but
 * its build-stamp.json does not match the hash of the current sources (e.g. after
 * `git pull`) or has no stamp at all (built before stamps existed).
 */
export function webBuildState(c: InstanceConfig): "ok" | "missing" | "stale" {
  const dir = webDir(c);
  if (!existsSync(join(dir, "index.html")) || !existsSync(join(dir, "ui.js"))) return "missing";
  // A custom webDir is someone else's build: never rebuild it.
  if (c.webDir) return "ok";
  return builtHash(dir) === sourceHash(REPO_DIR) ? "ok" : "stale";
}

function buildArgs(): [string, string[]] {
  const tsxCli = createRequire(join(PACKAGE_DIR, "package.json")).resolve("tsx/cli");
  return [process.execPath, [tsxCli, join(REPO_DIR, "apps", "web-mo", "build.ts")]];
}

/** Build apps/web-mo/dist if it is missing (first start after a fresh clone) or older than the sources. */
export function ensureWebBuilt(c: InstanceConfig, log: (s: string) => void = () => {}): string {
  const dir = webDir(c);
  const state = webBuildState(c);
  if (state === "ok") return dir;
  if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
  log(t(state === "stale" ? "s.rebuilding" : "s.building"));
  const [cmd, args] = buildArgs();
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], cwd: REPO_DIR });
  } catch (e) {
    throw new Error(String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" "));
  }
  return dir;
}

/** Async build (the setup spinner keeps turning while esbuild works). */
export async function buildWeb(c: InstanceConfig): Promise<string> {
  const dir = webDir(c);
  if (webBuildState(c) === "ok") return dir;
  if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
  const [cmd, args] = buildArgs();
  try {
    await promisify(execFile)(cmd, args, { cwd: REPO_DIR });
  } catch (e) {
    throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-3).join(" "));
  }
  return dir;
}

export function createServer(c: InstanceConfig, log: (s: string) => void = () => {}): DdnServer {
  const test = c.testing?.discordApiOrigin;
  const dir = ensureWebBuilt(c, log);
  return new DdnServer({
    dbPath: dbPath(c),
    signup: c.signup,
    trustProxy: c.trustProxy,
    corsOrigins: [originOf(c.publicUrl)],
    limits: c.limits,
    mode: c.mode,
    language: c.language,
    web: {
      dir,
      connectSrc: [...DISCORD_ORIGINS, ...(test ? [test] : [])],
      config: { serverUrl: originOf(c.publicUrl), language: c.language, ...(test ? { discordApiOrigin: test } : {}) },
    },
    bot: c.botToken ? new DiscordBotRefresher(c.botToken, test) : undefined,
    cdnOrigins: test ? [test] : [],
  });
}

export async function serve(c: InstanceConfig, log: (s: string) => void = console.log): Promise<DdnServer> {
  // The build notice goes to stderr: it is shown even when the caller silences the usual log.
  const srv = createServer(c, (s) => console.error(s));
  // Databases created before umask was set (older versions) are tightened here.
  if (POSIX_MODES) for (const f of [dbPath(c), `${dbPath(c)}-wal`, `${dbPath(c)}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  const { url } = await srv.listen(c.bind.port, c.bind.host);
  log(t("serve.log", { mode: c.mode, url, pub: c.publicUrl, signup: c.signup, share: c.botToken ? t("serve.yes") : t("serve.no") }));
  return srv;
}
