// Instance configuration: ONE file, <dataDir>/config.json (0600, dir 0700).
// Written by `discordrive setup`, read by `discordrive serve|doctor|invite`.
// .env.example stays as documentation only; the server does not read env files.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { t, type CliLang } from "./i18n.js";

export const CONFIG_VERSION = 1;
/**
 * Version of the risk text the first setup step shows (Discord's Terms of Service + no warranty).
 * Bump it when the text changes in substance: every instance is asked again.
 */
export const RISK_VERSION = 1;
export const DEFAULT_PORT = 3020;
export const UNIT_NAME = "discordrive-next.service";
export type SignupPolicy = "invite" | "open" | "closed";
/** Modes an instance can be built for. One instance = one mode, forever. */
export const MODES = ["metadata-only", "e2ee", "plain"] as const;
export type InstanceMode = (typeof MODES)[number];
/** Modes this checkout can build (plain comes after e2ee). */
export function availableModes(): InstanceMode[] {
  return MODES.filter((m) => existsSync(resolve(PACKAGE_DIR, "src", "modes", `${m}.ts`)));
}

export interface InstanceConfig {
  version: 1;
  /** Fixed when the instance is created; the build and the database must match it. */
  mode: InstanceMode;
  /** Public address users open (https://… behind a reverse proxy). */
  publicUrl: string;
  bind: { host: string; port: number };
  dataDir: string;
  /** Reverse proxies whose X-Forwarded-For is trusted (e.g. ["192.0.2.1"]). */
  trustProxy: string[];
  signup: SignupPolicy;
  /** Default language of the web app and the CLI (users can switch in the browser). */
  language: CliLang;
  /** Instance bot token for share links. Secret; null = sharing off. */
  botToken: string | null;
  /** Display info about the bot (from GET /users/@me at setup time). */
  bot?: { id: string; username: string } | null;
  limits: { bodyBytes: number; opPayloadB64: number; vaultB64: number };
  /** Override where the built web app is (default: apps/web-mo/dist next to this package). */
  webDir?: string;
  /** The operator accepted the risk text (ToS + no warranty) of this version at `at` (ISO time). */
  acceptedRisk?: { version: number; at: string } | null;
  /**
   * Transfer logs of every account (e2ee/plain: <dataDir>/logs/transfers-YYYY-MM-DD.jsonl, docs/transfer-log.md).
   * Off (default): each user turns them on for their own account in Settings → Diagnostics.
   */
  transferLogs?: boolean;
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

/** The built web app of this instance's mode (apps/web-mo/dist/<mode>). */
export function webDir(c: InstanceConfig): string {
  return c.webDir ?? resolve(WEB_DIR_DEFAULT, c.mode);
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
    language: "en",
    botToken: null,
    bot: null,
    limits: { ...DEFAULT_LIMITS },
  };
}

export class ConfigError extends Error {}

export function validate(c: InstanceConfig): string[] {
  const e: string[] = [];
  if (c.version !== 1) e.push(t("c.v.version"));
  if (!availableModes().includes(c.mode)) e.push(t("c.v.mode", { mode: String(c.mode) }));
  try {
    const u = new URL(c.publicUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") e.push(t("c.v.proto"));
    if (u.pathname !== "/" || u.search || u.hash) e.push(t("c.v.path"));
  } catch {
    e.push(t("c.v.url"));
  }
  if (!Number.isInteger(c.bind?.port) || c.bind.port < 1 || c.bind.port > 65535) e.push(t("c.v.port"));
  if (!c.bind?.host) e.push(t("c.v.host"));
  if (!["invite", "open", "closed"].includes(c.signup)) e.push(t("c.v.signup"));
  if (c.language !== "en" && c.language !== "pl") e.push(t("c.v.lang"));
  if (c.botToken !== null && typeof c.botToken !== "string") e.push(t("c.v.bot"));
  if (!Array.isArray(c.trustProxy)) e.push(t("c.v.proxy"));
  if (c.acceptedRisk != null && (typeof c.acceptedRisk !== "object" || !Number.isInteger(c.acceptedRisk.version) || typeof c.acceptedRisk.at !== "string")) e.push(t("c.v.risk"));
  return e;
}

export function loadConfig(dataDir: string): InstanceConfig {
  const p = configPath(dataDir);
  if (!existsSync(p)) throw new ConfigError(t("c.noConfig", { file: p }));
  let c: InstanceConfig;
  try {
    c = JSON.parse(readFileSync(p, "utf8")) as InstanceConfig;
  } catch {
    throw new ConfigError(t("c.notJson", { file: p }));
  }
  c = { ...defaults(dataDir), ...c, limits: { ...DEFAULT_LIMITS, ...c.limits } };
  const errs = validate(c);
  if (errs.length) throw new ConfigError(`${p}:\n  ${errs.join("\n  ")}`);
  return c;
}

/** Did the operator accept the CURRENT risk text? `start` and `doctor` refuse to run without it. */
export function riskAccepted(c: Pick<InstanceConfig, "acceptedRisk">): boolean {
  return !!c.acceptedRisk && c.acceptedRisk.version === RISK_VERSION;
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
    if (code === "EACCES" || code === "EPERM") return t("c.noWrite", { dir });
    if (code === "EROFS") return t("c.ro", { dir });
    if (code === "ENOSPC") return t("c.noSpace", { dir });
    return t("c.cannotWrite", { dir, code: code ?? (e as Error).message });
  }
}

export function dbPath(c: InstanceConfig): string {
  return join(c.dataDir, "ddn.db");
}
