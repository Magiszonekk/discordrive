// Instance configuration: ONE file, <dataDir>/config.json (0600, dir 0700).
// Written by `discordrive setup`, read by `discordrive serve|doctor|invite`.
// .env.example stays as documentation only; the server does not read env files.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_VERSION = 1;
export const DEFAULT_PORT = 3020;
export const UNIT_NAME = "discordrive-next.service";
export type SignupPolicy = "invite" | "open" | "closed";

export interface InstanceConfig {
  version: 1;
  /** Only "metadata-only" today; "e2ee" and "plain" come with stage 3. */
  mode: "metadata-only";
  /** Public address users open (https://… behind a reverse proxy). */
  publicUrl: string;
  bind: { host: string; port: number };
  dataDir: string;
  /** Reverse proxies whose X-Forwarded-For is trusted (e.g. ["192.0.2.1"]). */
  trustProxy: string[];
  signup: SignupPolicy;
  /** Instance bot token for share links (§3.7). Secret; null = sharing off. */
  botToken: string | null;
  /** Display info about the bot (from GET /users/@me at setup time). */
  bot?: { id: string; username: string } | null;
  limits: { bodyBytes: number; opPayloadB64: number; vaultB64: number };
  /** Override where the built web app is (default: apps/web-mo/dist next to this package). */
  webDir?: string;
  /** Tests only: send Discord API/CDN calls to a local fake. Never set on a real instance. */
  testing?: { discordApiOrigin?: string };
}

export const DEFAULT_LIMITS = { bodyBytes: 2 * 1024 * 1024, opPayloadB64: 1024 * 1024, vaultB64: 512 * 1024 };

/**
 * Platform data directory:
 *   Linux   $XDG_DATA_HOME/discordrive-next or ~/.local/share/discordrive-next
 *   macOS   ~/Library/Application Support/discordrive-next
 *   Windows %LOCALAPPDATA%\discordrive-next (fallback ~/AppData/Local)
 * DISCORDRIVE_DATA_DIR overrides all of them.
 */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.DISCORDRIVE_DATA_DIR) return env.DISCORDRIVE_DATA_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "discordrive-next");
  if (platform === "darwin") return join(home, "Library", "Application Support", "discordrive-next");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "discordrive-next");
}

/** POSIX file modes mean nothing on Windows (ACLs instead). */
export const POSIX_MODES = process.platform !== "win32";

/** The instance is only reachable from this computer (http://localhost…). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(here, "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "..", "..");
export const WEB_DIR_DEFAULT = resolve(REPO_DIR, "apps", "web-mo", "dist");

export function webDir(c: InstanceConfig): string {
  return c.webDir ?? WEB_DIR_DEFAULT;
}

export function defaults(dataDir = defaultDataDir()): InstanceConfig {
  return {
    version: 1,
    mode: "metadata-only",
    // Default scenario: one computer, nothing exposed (localhost is a secure
    // context, so the service worker and WebCrypto work without TLS).
    publicUrl: `http://localhost:${DEFAULT_PORT}`,
    bind: { host: "127.0.0.1", port: DEFAULT_PORT },
    dataDir,
    trustProxy: [],
    signup: "open",
    botToken: null,
    bot: null,
    limits: { ...DEFAULT_LIMITS },
  };
}

export class ConfigError extends Error {}

export function validate(c: InstanceConfig): string[] {
  const e: string[] = [];
  if (c.version !== 1) e.push("version: nieznana wersja pliku");
  if (c.mode !== "metadata-only") e.push(`mode: tryb ${c.mode} jeszcze nie istnieje`);
  try {
    const u = new URL(c.publicUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") e.push("publicUrl: tylko http(s)");
    if (u.pathname !== "/" || u.search || u.hash) e.push("publicUrl: sam adres, bez ścieżki (np. https://dysk.example.com)");
  } catch {
    e.push("publicUrl: to nie jest adres URL");
  }
  if (!Number.isInteger(c.bind?.port) || c.bind.port < 1 || c.bind.port > 65535) e.push("bind.port: 1–65535");
  if (!c.bind?.host) e.push("bind.host: pusty");
  if (!["invite", "open", "closed"].includes(c.signup)) e.push("signup: invite | open | closed");
  if (c.botToken !== null && typeof c.botToken !== "string") e.push("botToken: tekst albo null");
  if (!Array.isArray(c.trustProxy)) e.push("trustProxy: lista adresów");
  return e;
}

export function loadConfig(dataDir: string): InstanceConfig {
  const p = configPath(dataDir);
  if (!existsSync(p)) throw new ConfigError(`Brak konfiguracji w ${p}.\nNajpierw uruchom kreator: npm run setup`);
  let c: InstanceConfig;
  try {
    c = JSON.parse(readFileSync(p, "utf8")) as InstanceConfig;
  } catch {
    throw new ConfigError(`${p}: plik jest uszkodzony (to nie JSON)`);
  }
  c = { ...defaults(dataDir), ...c, limits: { ...DEFAULT_LIMITS, ...c.limits } };
  const errs = validate(c);
  if (errs.length) throw new ConfigError(`${p}:\n  ${errs.join("\n  ")}`);
  return c;
}

export function tryLoadConfig(dataDir: string): InstanceConfig | null {
  try {
    return loadConfig(dataDir);
  } catch {
    return null;
  }
}

/** Atomic write, 0600 file in a 0700 dir. */
export function saveConfig(c: InstanceConfig): string {
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  if (POSIX_MODES) chmodSync(c.dataDir, 0o700);
  const p = configPath(c.dataDir);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  if (POSIX_MODES) chmodSync(tmp, 0o600);
  renameSync(tmp, p);
  return p;
}

export function fileMode(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Can we create and write files in `dir`? Null if yes, else a human reason. */
export function checkWritable(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return `brak uprawnień do zapisu w ${dir}`;
    if (code === "EROFS") return `${dir} jest tylko do odczytu`;
    if (code === "ENOSPC") return `brak miejsca na dysku dla ${dir}`;
    return `nie da się zapisać w ${dir} (${code ?? (e as Error).message})`;
  }
}

export function dbPath(c: InstanceConfig): string {
  return join(c.dataDir, "ddn.db");
}
