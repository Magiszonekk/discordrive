// ddn: the command line of discordrive-next, for scripts and terminals, signed in with an API key
// (Settings → Account & security → API keys). Files are encrypted and decrypted here, like on any
// device of the account; the server never gets a key it could use.
//
//   ddn login [--key-file F] [--profile P]   store the key (read from stdin without --key-file)
//   ddn logout [--profile P]                 forget it on this computer (revoke it in the app)
//   ddn whoami                               account, device, mode, channels, space used
//   ddn ls [PATH] [-l]                       list a folder (default /)
//   ddn stat PATH                            one file or folder
//   ddn put SRC… DEST                        upload files / folders (folders recursively)
//   ddn get PATH [DEST]                      download a file (DEST "-" = stdout) or a folder (-r)
//   ddn mkdir [-p] PATH                      make a folder
//   ddn mv SRC… DEST                         move into a folder, or rename (one SRC, DEST not a folder)
//   ddn rm PATH…                             to the trash (--permanent: for good, asks or --yes)
//   ddn find TEXT                            search names (and descriptions where the account has them)
//   ddn version
// Paths are as in the app's Drive ("/Photos/2024/a.jpg"); --gallery for the Gallery. A node ID (as printed by
// --json) works wherever a path does. Output: lines for people, --json = one JSON object per line.
// Exit codes: 0 ok, 1 other failure, 2 usage, 3 no such file, 4 network/server, 5 key refused (revoked,
// damaged), 6 limits / no channel to upload to, 7 the profile is in use by `ddn serve` (nothing was done).

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getHealth, ApiKeyError, decodeApiKey, isNetworkError, ServerError, h2FetchMaybe } from "./deps.js";
import { CliError, EXIT, configRoot, ensurePrivateDir, envKeyText, forgetProfile, keyLine, parseArgs, profileDir, readProfile, writeProfile, type ModeName, type ParsedArgs } from "./profile.js";
import { selectMode } from "./mode-switch.js";
import { lockProfile, type ProfileLock } from "./lock.js";

export const CLI_VERSION = typeof __DDN_BUILD__ === "string" ? __DDN_BUILD__ : "dev";
declare const __DDN_BUILD__: string | undefined;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Progress line (stderr, rewritten in place on a terminal). */
  progress?(line: string | null): void;
  stdin?(): Promise<string>;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  /** Tests: Discord API origin of a fake. */
  discordApiOrigin?: string;
  /** Tests: fetch for Discord (e.g. h2 to a fake with its own CA). */
  discordFetch?: typeof fetch;
  /** `ddn serve` stops when this aborts (tests; the process uses SIGTERM / SIGINT). */
  stop?: AbortSignal;
  /** Ask a yes/no question (rm --permanent without --yes). */
  confirm?(q: string): Promise<boolean>;
}

const HELP = `ddn: discordrive-next from the command line

Sign in with an API key (in the app: Settings → Account & security → API keys):
  ddn login [--key-file FILE] [--profile NAME]   paste the key, or give the file
  DDN_API_KEY / DDN_API_KEY_FILE                  use a key without storing it

Commands:
  whoami                 account, mode, channels, space used
  ls [PATH] [-l]         list a folder (default /)
  stat PATH              one file or folder
  put SRC... DEST        upload files and folders (DEST ending in / = into that folder)
                         --on-conflict rename|replace|skip (default rename), --parents: make DEST
  get PATH [DEST]        download a file (DEST - = standard output) or a folder with -r
  mkdir [-p] PATH        make a folder
  mv SRC... DEST         move into a folder, or rename one item
  rm PATH...             to the trash; --permanent deletes for good (asks, or --yes)
  find TEXT              search by name
  serve [--listen H:P]   local HTTP API for scripts and services (docs/local-api.md)
  logout                 forget the key on this computer (revoke it in the app)
  version

Options: --json (one JSON object per line), --quiet / -q (no progress), --gallery (the Gallery
instead of the Drive), --profile NAME. Exit codes: 0 ok, 1 failed, 2 usage, 3 not found,
4 network or server, 5 key refused, 6 no channel / limits, 7 profile in use by ddn serve.`;

// The core and the desktop platform are loaded once the instance's mode is known.
type Core = import("../../web-mo/src/app-core.js").AppCore;

export interface Ctx {
  io: CliIo;
  p: ParsedArgs;
  json: boolean;
  quiet: boolean;
  core: Core;
  profile: { dir: string; mode: ModeName };
  space: "drive" | "gallery";
}

export function emit(c: { io: CliIo; json: boolean }, obj: Record<string, unknown>, human: string | null) {
  if (c.json) c.io.out(JSON.stringify(obj));
  else if (human !== null) c.io.out(human);
}

const fmtSize = (n: number | null) => {
  if (n === null) return "-";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) ((v /= 1024), i++);
  return i === 0 ? `${n} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-");

/** Map any failure to an exit code and a message without stack traces. */
export function classify(e: unknown): { code: number; message: string } {
  if (e instanceof CliError) return { code: e.code, message: e.message };
  if (e instanceof ApiKeyError) return { code: EXIT.auth, message: e.message };
  const m = String((e as Error)?.message ?? e);
  if (e instanceof ServerError) {
    if (e.status === 401 || e.status === 403) return { code: EXIT.auth, message: e.code === "account_blocked" ? "the account is blocked on this instance" : "the server refused this API key (revoked or from another account): make a new one in the app" };
    if (e.status === 429) return { code: EXIT.limit, message: "the server asks to slow down (429): try again later" };
    return { code: EXIT.network, message: `server: ${e.status} ${e.code}` };
  }
  if (/HTTP 401|bad_signature|device_revoked/.test(m)) return { code: EXIT.auth, message: "the server refused this API key (revoked?): make a new one in the app" };
  if (/account_blocked/.test(m)) return { code: EXIT.auth, message: "the account is blocked on this instance" };
  if (/need_channel/.test(m)) return { code: EXIT.limit, message: "the account has no channel to upload to: add one in the app (Settings → Channels)" };
  if (/429|rate.?limit/i.test(m)) return { code: EXIT.limit, message: m };
  if (isNetworkError(e) || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/.test(m)) return { code: EXIT.network, message: `cannot reach the server: ${m}` };
  if (/ENOENT/.test(m)) return { code: EXIT.notFound, message: m };
  return { code: EXIT.failed, message: m };
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let p: ParsedArgs;
  try {
    p = parseArgs(argv);
  } catch (e) {
    const x = classify(e);
    io.err(`ddn: ${x.message}`);
    return x.code;
  }
  const json = p.opts.has("--json");
  if (!p.cmd || p.cmd === "help" || p.opts.has("--help") || p.opts.has("-h")) {
    io.out(HELP);
    return p.cmd || p.opts.size ? EXIT.ok : EXIT.usage;
  }
  if (p.cmd === "version") {
    emit({ io, json }, { version: CLI_VERSION }, `ddn ${CLI_VERSION}`);
    return EXIT.ok;
  }
  let core: Core | null = null;
  let lock = null as ProfileLock | null;
  try {
    if (p.cmd === "login") return await login(io, p, json);
    if (p.cmd === "logout") return await logout(io, p, json);
    if (!COMMANDS[p.cmd]) throw new CliError(EXIT.usage, `unknown command ${p.cmd} (ddn help)`);
    const opened = await openAccount(io, p, (l) => void (lock = l));
    core = opened.core;
    const c: Ctx = { io, p, json, quiet: p.opts.has("--quiet") || p.opts.has("-q"), core, profile: opened.profile, space: p.opts.has("--gallery") ? "gallery" : "drive" };
    const fn = COMMANDS[p.cmd];
    if (!fn) throw new CliError(EXIT.usage, `unknown command ${p.cmd} (ddn help)`);
    return await fn(c);
  } catch (e) {
    const x = classify(e);
    if (json) io.out(JSON.stringify({ error: x.message, exit: x.code }));
    io.err(`ddn: ${x.message}`);
    return x.code;
  } finally {
    io.progress?.(null);
    core?.close();
    if (core) closeIndexes.get(core)?.();
    lock?.release();
  }
}

/** Each core's open file lists (one per core: `ddn serve` and a test's second command share a process). */
const closeIndexes = new WeakMap<Core, () => void>();
/** The profile's lock while a command runs (lock.ts). */
async function takeLock(io: CliIo, dir: string, cmd: string, json: boolean): Promise<ProfileLock> {
  ensurePrivateDir(dir);
  return lockProfile(dir, cmd, (h) => {
    if (!json) io.err(`ddn: waiting for another ddn command on this profile${h ? ` (process ${h.pid}, ${h.cmd})` : ""}…`);
  });
}

/** Which profile folder: --profile, else DDN_PROFILE, else "default"; with a key in the environment, one per key. */
async function where(io: CliIo, p: ParsedArgs): Promise<{ dir: string; keyText: string | null }> {
  const env = io.env ?? process.env;
  const root = ensurePrivateDir(configRoot(env));
  const keyText = envKeyText(env);
  if (keyText) {
    const k = await decodeApiKey(keyText);
    return { dir: join(root, `env-${k.deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}`), keyText };
  }
  const name = (p.opts.get("--profile") as string | undefined) ?? env.DDN_PROFILE ?? "default";
  return { dir: profileDir(root, name), keyText: null };
}

async function loadCore(dir: string, mode: string, io: CliIo, keysInMemory = false, logSrc: "cli" | "serve" = "cli"): Promise<Core> {
  selectMode(mode);
  const [{ AppCore }, { nodePlatform }] = await Promise.all([import("../../web-mo/src/app-core.js"), import("../../desktop/src/agent/node-platform.js")]);
  const f = io.discordFetch ?? (await h2FetchMaybe());
  const platform = nodePlatform({ dataDir: dir, discordFetch: f ?? undefined, downloadsDir: process.cwd() });
  let core: Core;
  if (keysInMemory) {
    type Stored = Awaited<ReturnType<typeof platform.keys.load>>;
    let held: Stored = undefined;
    const keys = { load: async () => held, save: async (a: NonNullable<Stored>) => void (held = a), clear: async () => void (held = undefined) };
    core = new AppCore({ discordApiOrigin: io.discordApiOrigin, logSrc }, { ...platform, keys });
  } else core = new AppCore({ discordApiOrigin: io.discordApiOrigin, logSrc }, platform);
  closeIndexes.set(core, () => platform.closeIndexes());
  return core;
}

async function instanceMode(server: string): Promise<ModeName> {
  const h = await getHealth(server);
  return selectMode(h.mode);
}

async function login(io: CliIo, p: ParsedArgs, json: boolean): Promise<number> {
  const env = io.env ?? process.env;
  if (envKeyText(env)) throw new CliError(EXIT.usage, "DDN_API_KEY / DDN_API_KEY_FILE is set: commands use it directly, no login needed");
  const file = p.opts.get("--key-file") as string | undefined;
  let text: string;
  if (file) text = readFileSync(file, "utf8");
  else if (io.stdin) {
    if (!json) io.err("Paste the API key (ddn-api1:…), then press Enter and Ctrl+D:");
    text = await io.stdin();
  } else throw new CliError(EXIT.usage, "usage: ddn login --key-file FILE (or the key on standard input)");
  // A downloaded key file has a few lines around the key: take the key line.
  const line = keyLine(text);
  const k = await decodeApiKey(line);
  const { dir } = await where(io, p);
  const lock = await takeLock(io, dir, "login", json);
  const mode = await instanceMode(k.server);
  const core = await loadCore(ensurePrivateDir(dir), mode, io);
  try {
    await core.useApiKey(line);
    // Proves the key works now (signs in, reads the list): a revoked key fails here, not on first use.
    await core.open();
    const st = await core.status();
    if (st.authLost) throw new CliError(EXIT.auth, "the server refused this API key (revoked?): make a new one in the app");
    writeProfile(dir, { v: 1, server: k.server, mode, accountId: k.accountId, deviceId: k.deviceId, at: Date.now() });
    emit({ io, json }, { ok: true, server: k.server, mode, accountId: k.accountId, deviceId: k.deviceId, profile: dir }, `Signed in to ${k.server} (${mode}) as account ${k.accountId}. Key stored in ${dir}`);
    return EXIT.ok;
  } catch (e) {
    core.close();
    closeIndexes.get(core)?.();
    // Unlocked first: an open lock file cannot be deleted on Windows.
    lock.release();
    forgetProfile(dir);
    throw e;
  } finally {
    core.close();
    closeIndexes.get(core)?.();
    lock.release();
  }
}

async function logout(io: CliIo, p: ParsedArgs, json: boolean): Promise<number> {
  const env = io.env ?? process.env;
  const root = configRoot(env);
  const name = (p.opts.get("--profile") as string | undefined) ?? env.DDN_PROFILE ?? "default";
  const dir = profileDir(root, name);
  // Not under a running `ddn serve` (or a transfer) of this profile.
  if (existsSync(dir)) {
    (await takeLock(io, dir, "logout", json)).release();
  }
  const gone = forgetProfile(dir);
  emit({ io, json }, { ok: true, removed: gone }, gone ? "Key forgotten on this computer. It still works elsewhere until you revoke it in the app." : "No key stored in this profile.");
  return EXIT.ok;
}

async function openAccount(io: CliIo, p: ParsedArgs, locked: (l: ProfileLock) => void): Promise<{ core: Core; profile: { dir: string; mode: ModeName } }> {
  const { dir, keyText } = await where(io, p);
  if (!keyText && !readProfile(dir)) throw new CliError(EXIT.auth, "not signed in: run `ddn login` (or set DDN_API_KEY)");
  locked(await takeLock(io, dir, p.cmd ?? "", p.opts.has("--json")));
  let mode: ModeName;
  let core: Core;
  if (keyText) {
    // Key from the environment: the key stays in memory (never written); the list and resume points are kept.
    const k = await decodeApiKey(keyText);
    const prof = readProfile(dir);
    mode = prof?.mode ?? (await instanceMode(k.server));
    ensurePrivateDir(dir);
    core = await loadCore(dir, mode, io, true, p.cmd === "serve" ? "serve" : "cli");
    await core.useApiKey(keyText);
    if (!prof) writeProfile(dir, { v: 1, server: k.server, mode, accountId: k.accountId, deviceId: k.deviceId, at: Date.now() });
  } else {
    const prof = readProfile(dir);
    if (!prof || !existsSync(join(dir, "keys.bin"))) throw new CliError(EXIT.auth, "not signed in: run `ddn login` (or set DDN_API_KEY)");
    mode = prof.mode;
    core = await loadCore(dir, mode, io, false, p.cmd === "serve" ? "serve" : "cli");
  }
  try {
    await core.open();
    const st = await core.status();
    if (st.authLost) throw new CliError(EXIT.auth, st.authLost === "blocked" ? "the account is blocked on this instance" : "the server refused this API key (revoked?): make a new one in the app");
  } catch (e) {
    // The caller never gets this core: close its file lists here (Windows cannot delete open files, `ddn logout`).
    core.close();
    closeIndexes.get(core)?.();
    throw e;
  }
  return { core, profile: { dir, mode } };
}

// ── paths ───────────────────────────────────────────────────────────

export const ROOTS = { drive: "root", gallery: "gallery" } as const;

export function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((x) => x && x !== ".");
}

/** Node ID of a path (or a node ID given as is); null if it does not exist. */
export function resolveRef(c: Ctx, ref: string): string | null {
  // A node ID as printed by --json (folders: 32 hex, files: 22 base64url characters); a path otherwise.
  if (!ref.includes("/") && /^[A-Za-z0-9_-]{16,64}$/.test(ref) && c.core.node(ref)) return ref;
  let id: string = ROOTS[c.space];
  for (const part of splitPath(ref)) {
    if (part === "..") {
      const n = c.core.node(id);
      id = n?.parentId ?? id;
      continue;
    }
    const next = c.core.childNamed(id, part);
    if (!next) return null;
    id = next;
  }
  return id;
}

export function mustResolve(c: Ctx, ref: string): string {
  const id = resolveRef(c, ref);
  if (!id) throw new CliError(EXIT.notFound, `no such file or folder: ${ref}`);
  return id;
}

export function pathOfId(c: Ctx, id: string): string {
  const parts: string[] = [];
  let cur: string | null = id;
  for (let i = 0; cur && cur !== ROOTS[c.space] && i < 256; i++) {
    const n = c.core.node(cur);
    if (!n || n.parentId === null) break;
    parts.unshift(n.name);
    cur = n.parentId;
  }
  return "/" + parts.join("/");
}

export async function mkdirs(c: Ctx, path: string): Promise<string> {
  let id: string = ROOTS[c.space];
  for (const part of splitPath(path)) {
    const next = c.core.childNamed(id, part);
    if (next) {
      if (c.core.node(next)?.kind !== "folder") throw new CliError(EXIT.failed, `not a folder: ${part}`);
      id = next;
    } else id = await c.core.mkdir(part, id);
  }
  return id;
}

export function folderId(c: Ctx, id: string, ref: string): string {
  if (c.core.node(id)?.kind !== "folder" && id !== ROOTS[c.space]) throw new CliError(EXIT.failed, `not a folder: ${ref}`);
  return id;
}

// ── progress ────────────────────────────────────────────────────────

function progress(c: Ctx, what: string) {
  if (c.quiet || !c.io.progress) return undefined;
  let last = 0;
  const t0 = Date.now();
  return (done: number, total: number) => {
    const t = Date.now();
    if (done < total && t - last < 250) return;
    last = t;
    const s = Math.max(0.001, (t - t0) / 1000);
    const pct = total ? Math.floor((done / total) * 100) : 100;
    c.io.progress!(`${what}: ${pct}% ${fmtSize(done)} / ${fmtSize(total)} · ${fmtSize(Math.round(done / s))}/s`);
  };
}

// ── commands ────────────────────────────────────────────────────────

type Cmd = (c: Ctx) => Promise<number>;

const COMMANDS: Record<string, Cmd> = {
  // The local service: one process keeps the account open and answers HTTP on this computer (serve.ts).
  async serve(c) {
    const { serve } = await import("./serve.js");
    return serve(c);
  },

  async whoami(c) {
    const st = await c.core.status();
    const ch = await c.core.webhooks(false).catch(() => null);
    const tot = await c.core.storageTotals().catch(() => null);
    const channels = ch ? ch.webhooks.filter((w) => !(w as { retired?: boolean }).retired).length + (ch.using !== "own" ? (ch.pool?.channels ?? 0) : 0) : null;
    const obj = {
      server: readProfile(c.profile.dir)?.server ?? null,
      mode: c.profile.mode,
      accountId: st.accountId,
      deviceId: st.deviceId,
      channels,
      canUpload: ch ? ch.advice.ok : null,
      files: tot?.files ?? null,
      bytes: tot?.bytes ?? null,
      version: CLI_VERSION,
    };
    emit(c, obj, [`server:   ${obj.server}`, `mode:     ${obj.mode}`, `account:  ${obj.accountId}`, `device:   ${obj.deviceId} (API key)`, `channels: ${channels ?? "?"}${ch && !ch.advice.ok ? " (none to upload to: add one in the app)" : ""}`, `files:    ${obj.files ?? "?"} (${fmtSize(obj.bytes)})`].join("\n"));
    return EXIT.ok;
  },

  async ls(c) {
    const ref = c.p.args[0] ?? "/";
    const id = mustResolve(c, ref);
    const n = c.core.node(id);
    if (n && n.kind === "file") {
      emit(c, { ...n, path: pathOfId(c, id) }, c.p.opts.has("-l") || c.p.opts.has("--long") ? `${fmtSize(n.size).padStart(10)}  ${fmtTime(n.modifiedAt)}  ${n.name}` : n.name);
      return EXIT.ok;
    }
    let after: string | undefined;
    const long = c.p.opts.has("-l") || c.p.opts.has("--long");
    for (;;) {
      const page = c.core.list(id, after, 500);
      for (const r of page.rows) {
        const obj = { id: r.id, name: r.name, kind: r.kind, size: r.size, modifiedAt: r.modifiedAt, path: `${pathOfId(c, id).replace(/\/$/, "")}/${r.name}` };
        const name = r.kind === "folder" ? `${r.name}/` : r.name;
        emit(c, obj, long ? `${r.kind === "folder" ? "       dir" : fmtSize(r.size).padStart(10)}  ${fmtTime(r.modifiedAt)}  ${name}` : name);
      }
      if (page.rows.length < 500) break;
      after = page.rows.at(-1)!.cursor;
    }
    return EXIT.ok;
  },

  async stat(c) {
    const ref = c.p.args[0];
    if (!ref) throw new CliError(EXIT.usage, "usage: ddn stat PATH");
    const id = mustResolve(c, ref);
    const n = c.core.node(id) ?? { id, name: "/", kind: "folder" as const, parentId: null, size: null, modifiedAt: null, sha256: null, trashed: false };
    const extra = n.kind === "folder" ? c.core.folderStats(id) : null;
    const obj = { ...n, path: pathOfId(c, id), ...(extra ? { folders: extra.folders, files: extra.files, bytes: extra.bytes } : {}) };
    emit(
      c,
      obj,
      [`path:     ${obj.path}`, `id:       ${n.id}`, `kind:     ${n.kind}`, ...(n.kind === "file" ? [`size:     ${fmtSize(n.size)} (${n.size} B)`, `modified: ${fmtTime(n.modifiedAt)}`, `sha256:   ${n.sha256 ?? "-"}`] : [`contents: ${extra!.folders} folders, ${extra!.files} files, ${fmtSize(extra!.bytes)}`])].join("\n"),
    );
    return EXIT.ok;
  },

  async mkdir(c) {
    const ref = c.p.args[0];
    if (!ref) throw new CliError(EXIT.usage, "usage: ddn mkdir [-p] PATH");
    const parts = splitPath(ref);
    if (!parts.length) throw new CliError(EXIT.usage, "usage: ddn mkdir [-p] PATH");
    const parents = c.p.opts.has("-p") || c.p.opts.has("--parents");
    const existing = resolveRef(c, ref);
    if (existing) {
      if (parents && c.core.node(existing)?.kind === "folder") {
        emit(c, { id: existing, path: pathOfId(c, existing), created: false }, null);
        return EXIT.ok;
      }
      throw new CliError(EXIT.failed, `already exists: ${ref}`);
    }
    const parentRef = "/" + parts.slice(0, -1).join("/");
    const parent = parents ? await mkdirs(c, parentRef) : resolveRef(c, parentRef);
    if (!parent) throw new CliError(EXIT.notFound, `no such folder: ${parentRef} (use -p)`);
    const id = await c.core.mkdir(parts.at(-1)!, folderId(c, parent, parentRef));
    emit(c, { id, path: pathOfId(c, id), created: true }, null);
    return EXIT.ok;
  },

  async put(c) {
    const a = c.p.args;
    if (a.length < 2) throw new CliError(EXIT.usage, "usage: ddn put SRC... DEST   (e.g. ddn put photo.jpg /Photos/)");
    const destRef = a.at(-1)!;
    const srcs = a.slice(0, -1);
    const onConflict = (c.p.opts.get("--on-conflict") as string | undefined) ?? "rename";
    if (!["rename", "replace", "skip"].includes(onConflict)) throw new CliError(EXIT.usage, "--on-conflict: rename, replace or skip");
    const parents = c.p.opts.has("--parents") || c.p.opts.has("-p");
    // DEST: an existing folder, a path ending in "/" (made with --parents), or a new name for one file.
    let destId = resolveRef(c, destRef);
    let rename: string | null = null;
    if (!destId || c.core.node(destId)?.kind === "file") {
      if (destRef.endsWith("/") || srcs.length > 1 || statSync(srcs[0]!).isDirectory()) {
        if (destId) throw new CliError(EXIT.failed, `not a folder: ${destRef}`);
        if (!parents) throw new CliError(EXIT.notFound, `no such folder: ${destRef} (use --parents to make it)`);
        destId = await mkdirs(c, destRef);
      } else {
        // One file under a new name (or over an existing file with --on-conflict replace).
        const parts = splitPath(destRef);
        rename = parts.pop() ?? null;
        const parentRef = "/" + parts.join("/");
        destId = parents ? await mkdirs(c, parentRef) : resolveRef(c, parentRef);
        if (!destId) throw new CliError(EXIT.notFound, `no such folder: ${parentRef} (use --parents)`);
      }
    }
    destId = folderId(c, destId, destRef);
    let failed = 0;
    let files = 0;
    let bytes = 0;
    const jobs: { path: string; folder: string[]; name: string }[] = [];
    const emptyFolders: string[][] = [];
    for (const s of srcs) {
      if (!existsSync(s)) {
        failed++;
        c.io.err(`ddn: no such file: ${s}`);
        emit(c, { path: s, error: "no such file" }, null);
        continue;
      }
      if (statSync(s).isDirectory()) {
        for (const f of await c.core.listPaths([resolve(s)])) jobs.push({ path: f.path, folder: f.folder, name: f.name });
        // Folders with no file in them are made too (the tree arrives as it is on disk).
        for (const d of emptyDirs(resolve(s))) emptyFolders.push(d);
      } else jobs.push({ path: resolve(s), folder: [], name: rename ?? basename(s) });
    }
    const folders = new Map<string, string>();
    const folderOf = async (names: string[]) => {
      const key = names.join("/");
      let id = folders.get(key);
      if (!id) {
        id = destId!;
        for (const part of names) id = c.core.childNamed(id, part) ?? (await c.core.mkdir(part, id));
        folders.set(key, id);
      }
      return id;
    };
    for (const names of emptyFolders) {
      const id = await folderOf(names);
      emit(c, { event: "folder", id, path: pathOfId(c, id) }, null);
    }
    for (const j of jobs) {
      try {
        let into = destId;
        if (j.folder.length) into = await folderOf(j.folder);
        const r = await c.core.uploadFile(j.path, into, j.name, onConflict as "rename", progress(c, j.name));
        c.io.progress?.(null);
        files += r.skipped ? 0 : 1;
        bytes += r.skipped ? 0 : r.size;
        const path = pathOfId(c, r.nodeId);
        emit(c, { event: "uploaded", source: j.path, id: r.nodeId, path, size: r.size, sha256: r.sha256 || null, skipped: r.skipped, replaced: r.replaced, resumedPieces: r.resumed }, r.skipped ? `skipped ${path} (exists)` : `${r.replaced ? "replaced" : "uploaded"} ${path} (${fmtSize(r.size)}${r.resumed ? `, resumed after ${r.resumed} pieces` : ""})`);
      } catch (e) {
        c.io.progress?.(null);
        const x = classify(e);
        // The key or the account is gone, or no channel: the rest would fail the same way.
        if (x.code === EXIT.auth || x.code === EXIT.limit) throw e;
        failed++;
        c.io.err(`ddn: ${j.path}: ${x.message}`);
        emit(c, { event: "failed", source: j.path, error: x.message }, null);
      }
    }
    if (!c.json && (jobs.length > 1 || failed)) c.io.out(`${files} uploaded (${fmtSize(bytes)})${failed ? `, ${failed} failed` : ""}`);
    return failed ? EXIT.failed : EXIT.ok;
  },

  async get(c) {
    const [ref, destArg] = c.p.args;
    if (!ref) throw new CliError(EXIT.usage, "usage: ddn get PATH [DEST]");
    const id = mustResolve(c, ref);
    const n = c.core.node(id);
    const isFolder = !n || n.kind === "folder";
    if (isFolder && !(c.p.opts.has("-r") || c.p.opts.has("--recursive"))) throw new CliError(EXIT.usage, `${ref} is a folder: use -r`);
    if (destArg === "-") {
      if (isFolder) throw new CliError(EXIT.usage, "a folder cannot go to standard output");
      const out = c.io.stdout ?? process.stdout;
      try {
        await c.core.downloadTo(id, { write: (d) => new Promise<void>((res, rej) => out.write(d, (e) => (e ? rej(e) : res()))) }, progress(c, n!.name));
      } catch (e) {
        // The reader closed the pipe (`| head -c 100`): what it wanted was delivered.
        if ((e as NodeJS.ErrnoException)?.code === "EPIPE") return EXIT.ok;
        throw e;
      }
      return EXIT.ok;
    }
    // DEST: an existing directory (into it), else a file name; default: the current directory.
    const dest = resolve(destArg ?? ".");
    const jobs: { id: string; target: string }[] = [];
    const dirs: string[] = [];
    const walk = (fid: string, dir: string) => {
      // Every folder is made, empty ones too (the tree comes back as put sent it).
      dirs.push(dir);
      let after: string | undefined;
      for (;;) {
        const page = c.core.list(fid, after, 500);
        for (const r of page.rows) {
          if (r.kind === "folder") walk(r.id, join(dir, safeName(r.name)));
          else jobs.push({ id: r.id, target: join(dir, safeName(r.name)) });
        }
        if (page.rows.length < 500) break;
        after = page.rows.at(-1)!.cursor;
      }
    };
    if (isFolder) walk(id, existsSync(dest) && statSync(dest).isDirectory() ? join(dest, safeName(n?.name || "drive")) : dest);
    else jobs.push({ id, target: existsSync(dest) && statSync(dest).isDirectory() ? join(dest, safeName(n!.name)) : dest });
    let failed = 0;
    for (const d of dirs) mkdirSync(d, { recursive: true });
    for (const j of jobs) {
      try {
        mkdirSync(resolve(j.target, ".."), { recursive: true });
        const part = `${j.target}.ddnpart`;
        const ws = createWriteStream(part);
        const done = new Promise<void>((res, rej) => (ws.on("finish", res), ws.on("error", rej)));
        const r = await c.core
          .downloadTo(j.id, { write: (d) => new Promise<void>((res, rej) => ws.write(d, (e) => (e ? rej(e) : res()))) }, progress(c, basename(j.target)))
          .finally(() => ws.end());
        await done;
        const { renameSync } = await import("node:fs");
        renameSync(part, j.target);
        c.io.progress?.(null);
        emit(c, { event: "downloaded", id: j.id, path: pathOfId(c, j.id), target: j.target, size: r.bytes, sha256: r.sha256 }, `downloaded ${j.target} (${fmtSize(r.bytes)})`);
      } catch (e) {
        c.io.progress?.(null);
        const x = classify(e);
        if (x.code === EXIT.auth) throw e;
        failed++;
        c.io.err(`ddn: ${pathOfId(c, j.id)}: ${x.message}`);
        emit(c, { event: "failed", id: j.id, error: x.message }, null);
      }
    }
    return failed ? EXIT.failed : EXIT.ok;
  },

  async mv(c) {
    const a = c.p.args;
    if (a.length < 2) throw new CliError(EXIT.usage, "usage: ddn mv SRC... DEST");
    const destRef = a.at(-1)!;
    const ids = a.slice(0, -1).map((r) => mustResolve(c, r));
    const dest = resolveRef(c, destRef);
    if (dest && (c.core.node(dest)?.kind === "folder" || dest === ROOTS[c.space])) {
      const r = await c.core.move(ids, dest);
      for (const id of ids) emit(c, { event: "moved", id, path: pathOfId(c, id), outcome: r.outcome }, null);
      return r.outcome === "rejected" ? EXIT.failed : EXIT.ok;
    }
    if (ids.length > 1) throw new CliError(EXIT.notFound, `no such folder: ${destRef}`);
    // One item to a new path: move to its folder (if other) and rename.
    const parts = splitPath(destRef);
    const name = parts.pop();
    if (!name) throw new CliError(EXIT.usage, "usage: ddn mv SRC... DEST");
    const parentRef = "/" + parts.join("/");
    const parent = resolveRef(c, parentRef);
    if (!parent) throw new CliError(EXIT.notFound, `no such folder: ${parentRef}`);
    if (dest) throw new CliError(EXIT.failed, `already exists: ${destRef}`);
    if (c.core.node(ids[0]!)?.parentId !== parent) await c.core.move(ids, folderId(c, parent, parentRef));
    const r = await c.core.rename(ids[0]!, name);
    emit(c, { event: "moved", id: ids[0], path: pathOfId(c, ids[0]!), outcome: r.outcome }, null);
    return EXIT.ok;
  },

  async rm(c) {
    if (!c.p.args.length) throw new CliError(EXIT.usage, "usage: ddn rm PATH...");
    const ids = c.p.args.map((r) => mustResolve(c, r));
    if (ids.some((id) => id === ROOTS[c.space])) throw new CliError(EXIT.usage, "cannot remove the root");
    const paths = ids.map((id) => pathOfId(c, id));
    if (c.p.opts.has("--permanent")) {
      const yes = c.p.opts.has("--yes") || c.p.opts.has("-y") || (c.io.confirm ? await c.io.confirm(`Delete for good (no trash, no undo): ${paths.join(", ")}?`) : false);
      if (!yes) throw new CliError(EXIT.usage, "not deleted: confirm with --yes");
      await c.core.trash(ids);
      await c.core.purge(ids);
      for (const [i, id] of ids.entries()) emit(c, { event: "deleted", id, path: paths[i] }, `deleted ${paths[i]}`);
      return EXIT.ok;
    }
    await c.core.trash(ids);
    for (const [i, id] of ids.entries()) emit(c, { event: "trashed", id, path: paths[i] }, `moved to the trash: ${paths[i]}`);
    return EXIT.ok;
  },

  async find(c) {
    const q = c.p.args.join(" ").trim();
    if (!q) throw new CliError(EXIT.usage, "usage: ddn find TEXT");
    const hits = await c.core.search(q, c.space);
    for (const h of hits) emit(c, { id: h.id, name: h.name, kind: h.kind, size: h.size, path: pathOfId(c, h.id) }, pathOfId(c, h.id));
    return hits.length ? EXIT.ok : EXIT.notFound;
  },
};

/** Folders under `dir` with no file anywhere below them, as name paths starting with `dir`'s own name. */
function emptyDirs(dir: string): string[][] {
  const out: string[][] = [];
  const base = basename(dir);
  const go = (d: string, rel: string[]): boolean => {
    let hasFile = false;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) hasFile = go(join(d, e.name), [...rel, e.name]) || hasFile;
      else if (e.isFile()) hasFile = true;
    }
    if (!hasFile) out.push([base, ...rel]);
    return hasFile;
  };
  go(dir, []);
  // Only the deepest ones: making them makes their parents.
  return out.filter((p) => !out.some((q) => q.length > p.length && p.every((x, i) => q[i] === x)));
}

export function safeName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s || "file";
}
