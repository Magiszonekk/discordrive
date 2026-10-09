// `discordrive serve`: one process for the API (/v1/...), the notify
// websocket (/v1/notify) and the built web app, from the same origin.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DdnServer, DiscordBotRefresher, DISCORD_ORIGINS } from "@ddv4/metadata-client/node";
import { REPO_DIR, dbPath, originOf, webDir, type InstanceConfig } from "./config.js";

/** Build apps/web-mo/dist if it is missing (first start after a fresh clone). */
export function ensureWebBuilt(c: InstanceConfig, log: (s: string) => void = () => {}): string {
  const dir = webDir(c);
  if (existsSync(join(dir, "index.html")) && existsSync(join(dir, "ui.js"))) return dir;
  if (c.webDir) throw new Error(`webDir ${dir}: brak zbudowanej aplikacji (index.html, ui.js)`);
  log("Budowanie aplikacji przeglądarkowej (apps/web-mo)…");
  execFileSync(process.execPath, [join(REPO_DIR, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_DIR, "apps", "web-mo", "build.ts")], { stdio: "ignore" });
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
    web: {
      dir,
      connectSrc: [...DISCORD_ORIGINS, ...(test ? [test] : [])],
      config: { serverUrl: originOf(c.publicUrl), ...(test ? { discordApiOrigin: test } : {}) },
    },
    bot: c.botToken ? new DiscordBotRefresher(c.botToken, test) : undefined,
    cdnOrigins: test ? [test] : [],
  });
}

export async function serve(c: InstanceConfig, log: (s: string) => void = console.log): Promise<DdnServer> {
  const srv = createServer(c);
  // Databases created before umask was set (older versions) are tightened here.
  for (const f of [dbPath(c), `${dbPath(c)}-wal`, `${dbPath(c)}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  const { url } = await srv.listen(c.bind.port, c.bind.host);
  log(`discordrive-next ${c.mode}: nasłuch ${url}, adres publiczny ${c.publicUrl}, rejestracja: ${c.signup}, udostępnianie: ${c.botToken ? "tak" : "nie (brak bota)"}`);
  return srv;
}
