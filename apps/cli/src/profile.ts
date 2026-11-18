// Where `ddn` keeps what it knows, and the parts of the command line every step needs before the
// application core is loaded (the core is built for one mode, picked from the instance: mode.ts).
//
// Profile folder (owner-only): <config>/ddn/<profile>/
//   profile.json  server, instance mode, account and device IDs (no secret)
//   keys.bin      the API key's account key and device key (written by `ddn login`, 0600)
//   index/        the account's file list (SQLite), so a command does not fetch it again
//   resume/       unfinished uploads and downloads
// With DDN_API_KEY / DDN_API_KEY_FILE the key is never written: only the list and the resume points
// are kept, in a folder per key (<config>/ddn/env-<device>).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModeName = "metadata-only" | "e2ee" | "plain";

export interface ProfileFile {
  v: 1;
  server: string;
  mode: ModeName;
  accountId: string;
  deviceId: string;
  /** When `ddn login` stored the key. */
  at: number;
}

/** Exit codes (stable, documented in docs/cli.md). */
export const EXIT = { ok: 0, failed: 1, usage: 2, notFound: 3, network: 4, auth: 5, limit: 6 } as const;

export class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function configRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DDN_CONFIG_DIR) return env.DDN_CONFIG_DIR;
  if (process.platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "ddn");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ddn");
}

export function ensurePrivateDir(d: string): string {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(d, 0o700);
  return d;
}

export const PROFILE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

export function profileDir(root: string, profile: string): string {
  if (!PROFILE_RE.test(profile) || profile.startsWith(".") || profile.startsWith("env-")) throw new CliError(EXIT.usage, `bad profile name: ${profile} (letters, digits, . _ -)`);
  return join(root, profile);
}

export function readProfile(dir: string): ProfileFile | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as ProfileFile;
    return j && j.v === 1 && typeof j.server === "string" ? j : null;
  } catch {
    return null;
  }
}

export function writeProfile(dir: string, p: ProfileFile): void {
  ensurePrivateDir(dir);
  const f = join(dir, "profile.json");
  writeFileSync(f, JSON.stringify(p, null, 1) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(f, 0o600);
}

export function forgetProfile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Options that may stand anywhere on the command line. Boolean flags take no value. */
const VALUE_FLAGS = new Set(["--profile", "--key-file", "--on-conflict", "--name"]);
const BOOL_FLAGS = new Set(["--json", "--quiet", "-q", "--gallery", "--parents", "-p", "-l", "--long", "--permanent", "--yes", "-y", "--help", "-h", "--recursive", "-r", "--no-progress"]);

export interface ParsedArgs {
  cmd: string | null;
  args: string[];
  opts: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const opts = new Map<string, string | true>();
  const rest: string[] = [];
  let onlyArgs = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (onlyArgs || a === "-" || !a.startsWith("-")) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      onlyArgs = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new CliError(EXIT.usage, `${name} needs a value`);
      opts.set(name, v);
    } else if (BOOL_FLAGS.has(name) && eq < 0) opts.set(name, true);
    else throw new CliError(EXIT.usage, `unknown option ${a} (ddn help)`);
  }
  return { cmd: rest[0] ?? null, args: rest.slice(1), opts };
}

/** The key line of a text: the app's "Download file" puts a title, the server and a how-to around it. */
export function keyLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().startsWith("ddn-"))?.trim() ?? text;
}

/** The API key text from the environment, if any (DDN_API_KEY or the file DDN_API_KEY_FILE names). */
export function envKeyText(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DDN_API_KEY) return keyLine(env.DDN_API_KEY);
  if (env.DDN_API_KEY_FILE) {
    try {
      return keyLine(readFileSync(env.DDN_API_KEY_FILE, "utf8"));
    } catch (e) {
      throw new CliError(EXIT.auth, `DDN_API_KEY_FILE: ${String((e as Error).message)}`);
    }
  }
  return null;
}
