// `discordrive serve`: one process for the API (/v1/...), the notify
// websocket (/v1/notify) and the built web app, from the same origin.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DdnServer, DiscordBotRefresher, DISCORD_ORIGINS } from "@ddv4/metadata-client/node";
import { t } from "./i18n.js";
import { PACKAGE_DIR, POSIX_MODES, REPO_DIR, dbPath, originOf, webDir, type InstanceConfig } from "./config.js";

/** Build apps/web-mo/dist if it is missing (first start after a fresh clone). */
export function ensureWebBuilt(c: InstanceConfig, log: (s: string) => void = () => {}): string {
  const dir = webDir(c);
  if (existsSync(join(dir, "index.html")) && existsSync(join(dir, "ui.js"))) return dir;
  if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
  log(t("s.building"));
  const tsxCli = createRequire(join(PACKAGE_DIR, "package.json")).resolve("tsx/cli");
  try {
    execFileSync(process.execPath, [tsxCli, join(REPO_DIR, "apps", "web-mo", "build.ts")], { stdio: ["ignore", "ignore", "pipe"], cwd: REPO_DIR });
  } catch (e) {
    throw new Error(String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" "));
  }
  return dir;
}

/** Async build (the setup spinner keeps turning while esbuild works). */
export async function buildWeb(c: InstanceConfig): Promise<string> {
  const dir = webDir(c);
  if (existsSync(join(dir, "index.html")) && existsSync(join(dir, "ui.js"))) return dir;
  if (c.webDir) throw new Error(t("c.webDirMissing", { dir }));
  const tsxCli = createRequire(join(PACKAGE_DIR, "package.json")).resolve("tsx/cli");
  try {
    await promisify(execFile)(process.execPath, [tsxCli, join(REPO_DIR, "apps", "web-mo", "build.ts")], { cwd: REPO_DIR });
  } catch (e) {
    throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-3).join(" "));
  }
  return dir;
}

export function createServer(c: InstanceConfig): DdnServer {
  const test = c.testing?.discordApiOrigin;
  const dir = ensureWebBuilt(c);
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
  const srv = createServer(c);
  // Databases created before umask was set (older versions) are tightened here.
  if (POSIX_MODES) for (const f of [dbPath(c), `${dbPath(c)}-wal`, `${dbPath(c)}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  const { url } = await srv.listen(c.bind.port, c.bind.host);
  log(t("serve.log", { mode: c.mode, url, pub: c.publicUrl, signup: c.signup, share: c.botToken ? t("serve.yes") : t("serve.no") }));
  return srv;
}
