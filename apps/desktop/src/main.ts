// Main process of the desktop app (the "shell"): window, tray, autostart, first start, the built-in
// instance, the OS key store and update checks. It moves no data itself: transfers run in the agent (a
// separate Node process, agent.ts), so a stuck transfer never freezes the window, and the agent keeps
// working with the window closed.
//
// Security (Electron security checklist): the window has no Node (sandbox, contextIsolation, no
// nodeIntegration), loads only the app's own files from app://ddn (the built web app and the start page),
// with a CSP; it may not navigate anywhere else (http(s) links open in the system browser), may not open
// windows or <webview>s, and gets no permissions. IPC: one channel for the agent's port (sent only to the
// app's own main frame), and a few invoke handlers that check the sender frame and every argument.
import { Vdisk, VdiskWin } from "./vdisk.js";
import { app, BrowserWindow, Menu, clipboard, MessageChannelMain, Notification, Tray, dialog, ipcMain, nativeImage, net, protocol, safeStorage, session, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { ORIGIN, SCHEME, isAppUrl, staticPath as staticPathIn } from "./shell/paths.js";
import { pathToFileURL } from "node:url";
import { DISCORD_ORIGINS } from "@ddv4/metadata-client/node";
import { STREAM_PREFIX, guessType, parseRange } from "@ddv4/metadata-client";
import { autostartOn, setAutostart, HIDDEN_ARG, type AutostartEnv } from "./shell/autostart.js";
import { loadSettings, normaliseServerUrl, saveSettings, type DesktopSettings } from "./shell/settings.js";
import type { AgentInit } from "./agent.js";
import { appArmorCommand, appImageWithoutSandbox } from "./shell/sandbox.js";
import { hasDefaultKeyring, keyringPlan, keysProtection } from "./shell/keyring.js";
import { APP_USER_MODEL_ID } from "./shell/app-id.js";
import { CHECK_EVERY_MS, assetFor, canInstallInPlace, debInstallCommand, debTerminalCommand, downloadVerified, findPkexec, installHint, installKind, isNewer, latestBuild, nsisUpdateCommand, replaceAppImage, sha256File, type AvailableBuild } from "./shell/updates.js";

const APP_ID = "discordrive";
const APP_NAME = "discordrive";
/** Built app files: static/ (start page), web/<mode>/ (the web app); nothing outside these is served. */
const ROOT = __dirname;
const MODES = ["metadata-only", "e2ee", "plain"] as const;

// Windows: the same AppUserModelID as the installer's shortcuts (shell/app-id.ts); without it Electron uses
// "electron.app.<name>" and a pin made from a shortcut shows up as a second taskbar icon next to the app.
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Test runs (CI) put the data folder elsewhere and may hide the window. */
if (process.env.DDN_DESKTOP_DATA) app.setPath("userData", process.env.DDN_DESKTOP_DATA);
const DATA = () => app.getPath("userData");
// Linux, the user said no to the keyring and no keys are sealed by it: Chromium itself would still touch the
// secret service at start (gnome-keyring's "create a keyring" window once a session). Its own store is not
// used by the app (cookies of app:// only), so it stays off the keyring too.
if (process.platform === "linux" && !process.env.DDN_DESKTOP_TEST_KEYSTORE_FILE) {
  try {
    const st = JSON.parse(readFileSync(join(DATA(), "desktop-settings.json"), "utf8")) as { keyring?: string };
    if (st.keyring === "file" && keysProtection(join(DATA(), "agent", "keys.bin")) !== "S") app.commandLine.appendSwitch("password-store", "basic");
  } catch {
    /* no settings yet */
  }
}

let win: BrowserWindow | null = null;
let agent: UtilityProcess | null = null;
let instance: UtilityProcess | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
/** The server the app talks to now (local: its address at this start). */
let server: { url: string; mode: string; kind: "remote" | "local" } | null = null;
let quitting = false;
let busy = { busy: false, up: { n: 0, done: 0, total: 0 }, down: { n: 0, done: 0, total: 0 } };
// Tests (e2e): whether a transfer still runs, as the tray and Quit see it.
(globalThis as unknown as { __ddnBusy?: () => boolean }).__ddnBusy = () => busy.busy;

const staticPath = (url: string) => staticPathIn(url, ROOT, server?.mode ?? "metadata-only");

/** CSP of the window: the app's own files, the server it talks to, Discord (metadata only reads/writes there). */
function csp(): string {
  const connect = ["'self'", ...(server ? [server.url, server.url.replace(/^http/, "ws")] : []), ...DISCORD_ORIGINS, ...(process.env.DDN_DESKTOP_TEST_DISCORD ? [process.env.DDN_DESKTOP_TEST_DISCORD] : [])];
  return [
    "default-src 'self'",
    "script-src 'self'",
    // index.html has a few inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

// ── the agent ──────────────────────────────────────────────────────────────────────────────────────
let agentReady: Promise<void> = Promise.resolve();
let sealerKind: "os" | "file" = "file";

function startAgent(): UtilityProcess {
  const a = utilityProcess.fork(join(ROOT, "agent.cjs"), [], { serviceName: "discordrive agent", stdio: "inherit" });
  agentReady = new Promise((r) =>
    a.once("spawn", () => {
      const init: AgentInit = {
        type: "init",
        dataDir: join(DATA(), "agent"),
        downloadsDir: downloadsDir(),
        sealer: sealerKind,
        ...(process.env.DDN_DESKTOP_TEST_DISCORD ? { discordApiOrigin: process.env.DDN_DESKTOP_TEST_DISCORD } : {}),
        ...(process.env.DDN_DESKTOP_TEST_CA ? { tlsCa: readFileSync(process.env.DDN_DESKTOP_TEST_CA, "utf8") } : {}),
        ...(server?.kind === "local" ? { serverUrl: server.url } : {}),
        ...vdiskInit(),
      };
      a.postMessage(init);
      r();
    }),
  );
  a.on("message", (m: { type?: string; id?: number; data?: Uint8Array; busy?: boolean; kind?: string; name?: string; bytes?: number }) => void onAgentMessage(a, m));
  a.on("exit", (code) => {
    if (agent === a) agent = null;
    // Crashed: start it again (it resumes unfinished downloads by itself); open windows reconnect.
    if (!quitting && code !== 0)
      setTimeout(() => {
        if (quitting || agent) return;
        agent = startAgent();
        if (win && !win.isDestroyed()) win.webContents.reload();
      }, 1000);
  });
  return a;
}

// ── the disk in the system (Linux) ──
const VDISK_WIN = process.platform === "win32";
const VDISK_HELPER = () =>
  VDISK_WIN
    ? app.isPackaged
      ? join(process.resourcesPath, "ddn-cf.exe")
      : join(ROOT, "..", "native", "cf", "target", "release", "ddn-cf.exe")
    : app.isPackaged
      ? join(process.resourcesPath, "ddn-fuse")
      : join(ROOT, "..", "native", "fuse", "target", "release", "ddn-fuse");
/** The disk exists on Linux (FUSE) and Windows (Cloud Files; read-only for now). */
const VDISK_OS = process.platform === "linux" || VDISK_WIN;
const vdiskUnavailable = () => (VDISK_WIN ? VdiskWin.unavailable(VDISK_HELPER()) : Vdisk.unavailable(VDISK_HELPER()));
const VDISK_DIR = () => join(app.getPath("home"), "discordrive");
let vdiskState = "off";
let vdiskQueue = { left: 0, done: 0, total: 0 };
function vdiskInit(): Partial<AgentInit> {
  if (!VDISK_OS) return {};
  if (VDISK_WIN)
    return {
      vdisk: {
        on: settings.vdisk === true,
        helper: VDISK_HELPER(),
        mountpoint: VDISK_DIR(),
        // One pipe per user session (the helper proves itself with a secret it is started with).
        socket: `\\\\.\\pipe\\discordrive-cf-${process.env.USERNAME ?? "user"}-${process.pid}`,
        cacheDir: join(app.getPath("userData"), "disk-cache"),
        cacheBytes: settings.vdiskCacheBytes ?? 10 * 1024 ** 3,
        windows: { icon: process.execPath, version: app.getVersion() },
      },
    };
  return {
    vdisk: {
      on: settings.vdisk === true,
      helper: VDISK_HELPER(),
      mountpoint: VDISK_DIR(),
      socket: join(process.env.XDG_RUNTIME_DIR || join(DATA(), "run"), "discordrive", "fuse.sock"),
      cacheDir: join(process.env.XDG_CACHE_HOME || join(app.getPath("home"), ".cache"), "discordrive", "frags"),
      cacheBytes: settings.vdiskCacheBytes ?? 10 * 1024 ** 3,
      // Files written into the disk wait for their upload here (kept across restarts).
      ...(settings.vdiskWrite === true ? { outbox: join(DATA(), "vdisk-outbox") } : {}),
    },
  };
}

async function onAgentMessage(a: UtilityProcess, m: { type?: string; id?: number; data?: Uint8Array; busy?: boolean; kind?: string; name?: string; bytes?: number } & Record<string, unknown>) {
  if (m.type === "vdisk-state" && typeof m.state === "string") {
    vdiskState = m.state;
    return;
  }
  if (m.type === "vdisk-queue") {
    vdiskQueue = { left: Number(m.left) || 0, done: Number(m.done) || 0, total: Number(m.total) || 0 };
    return;
  }
  if (m.type === "seal" || m.type === "unseal") {
    try {
      // Tests (DDN_DESKTOP_TEST_KEYSTORE_FILE): a stand-in key store that opens what it sealed (no real keyring
      // on a CI runner). Never in a normal run.
      const testStore = process.env.DDN_DESKTOP_TEST_KEYSTORE_FILE ? (b: Uint8Array) => Buffer.from(b.map((x) => x ^ 0x5a)) : null;
      const data = testStore ? testStore(m.data!) : m.type === "seal" ? await safeStorage.encryptStringAsync(Buffer.from(m.data!).toString("base64")) : Buffer.from((await safeStorage.decryptStringAsync(Buffer.from(m.data!))).result, "base64");
      a.postMessage({ type: "sealed", id: m.id, ok: true, data: new Uint8Array(data) });
    } catch (e) {
      a.postMessage({ type: "sealed", id: m.id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  } else if (m.type === "range-result") {
    const w = rangeWait.get(m.id!);
    rangeWait.delete(m.id!);
    w?.(m as unknown as RangeResult);
  } else if (m.type === "status") {
    busy = m as unknown as typeof busy;
    paintTray();
  } else if (m.type === "notify" && Notification.isSupported()) {
    const up = m.kind === "up-done";
    new Notification({ title: up ? "Upload finished" : "Download finished", body: `${m.name ?? ""} (${Math.round((m.bytes ?? 0) / 1e6)} MB)` }).show();
  }
}

// ── media and large previews: Range requests answered by the agent ─────────────────────────────────
// In a browser a service worker answers /ddn/file/<id> (the player seeks, only the fragments needed are
// fetched and decrypted). app:// has no service worker, so the protocol handler does the same here, asking the
// agent (AppCore.readRange: a few fragments, decrypted there, a small cache) one window at a time.
// An open range ("bytes=N-", what players send) is answered with the WHOLE rest of the file as a stream, one
// window per pull: Chromium takes a shorter answer to an open range on a custom protocol as the end of the file
// (an MP4 whose `moov` is at the end then fails to open, and seeking inside it fails). The stream is pulled
// only as fast as the player reads, and a seek cancels it (the player opens a new range), so no request holds
// more than a window in memory.
type RangeResult = { ok: boolean; data?: Uint8Array; size?: number; start?: number; end?: number; name?: string; error?: string };
const rangeWait = new Map<number, (r: RangeResult) => void>();
let rangeSeq = 0;
/** Bytes per agent call (about the size of a fragment). */
const STREAM_WINDOW = 4 * 1024 * 1024;
async function agentRange(nodeId: string, start: number, end: number): Promise<RangeResult> {
  if (!agent) agent = startAgent();
  await agentReady;
  const a = agent;
  const id = ++rangeSeq;
  return new Promise<RangeResult>((res) => {
    const t = setTimeout(() => (rangeWait.delete(id), res({ ok: false, error: "timeout" })), 120_000);
    rangeWait.set(id, (x) => (clearTimeout(t), res(x)));
    a.postMessage({ type: "range", id, nodeId, start, end });
  });
}
async function streamResponse(req: Request, u: URL): Promise<Response> {
  let nodeId: string;
  try {
    nodeId = decodeURIComponent(u.pathname.slice(STREAM_PREFIX.length));
  } catch {
    return new Response("bad id", { status: 400 });
  }
  if (req.method !== "GET" || !/^[A-Za-z0-9_:-]{1,128}$/.test(nodeId)) return new Response("not found", { status: 404 });
  const rangeHeader = req.headers.get("range");
  // The size comes with the URL (?size=); without it the first window tells it.
  let size = Number(u.searchParams.get("size") ?? NaN);
  const parsed = Number.isFinite(size) && size > 0 ? parseRange(rangeHeader, size, Number.MAX_SAFE_INTEGER) : null;
  if (parsed === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const start = parsed?.start ?? 0;
  const first = await agentRange(nodeId, start, start + STREAM_WINDOW - 1);
  if (!first.ok || !first.data) return new Response(first.error ?? "error", { status: 404 });
  size = first.size!;
  const end = parsed ? Math.min(parsed.end, size - 1) : size - 1;
  const type = guessType(first.name ?? "");
  const headers: Record<string, string> = { "accept-ranges": "bytes", "content-type": type, "content-length": String(end - start + 1), "cache-control": "no-store" };
  const whole = !rangeHeader && start === 0 && end === size - 1;
  if (!whole) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  let next = start;
  let pending: Uint8Array | null = first.data.subarray(0, Math.min(first.data.byteLength, end - start + 1));
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        if (pending) {
          const d = pending;
          pending = null;
          next += d.byteLength;
          c.enqueue(d);
        } else {
          const r = await agentRange(nodeId, next, Math.min(end, next + STREAM_WINDOW - 1));
          if (!r.ok || !r.data || !r.data.byteLength) return c.error(new Error(r.error ?? "read failed"));
          next += r.data.byteLength;
          c.enqueue(r.data);
        }
        if (next > end) c.close();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: whole ? 200 : 206, headers });
}

/** Hand a window a fresh direct channel to the agent (a reloaded window asks again). */
function connectWindow(w: BrowserWindow) {
  if (!agent) agent = startAgent();
  const a = agent;
  void agentReady.then(() => {
    if (w.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    a.postMessage({ type: "port" }, [port1]);
    w.webContents.postMessage("ddn:agent-port", null, [port2]);
  });
}

// ── the built-in instance ("This computer only") ───────────────────────────────────────────────────
function startInstance(): Promise<{ url: string; invite: string | null }> {
  return new Promise((resolve, reject) => {
    const p = utilityProcess.fork(join(ROOT, "local-instance.cjs"), [], { serviceName: "discordrive instance", stdio: "inherit" });
    instance = p;
    p.once("spawn", () => p.postMessage({ type: "start", dataDir: join(DATA(), "instance"), ...(process.env.DDN_DESKTOP_TEST_DISCORD ? { discordApiOrigin: process.env.DDN_DESKTOP_TEST_DISCORD } : {}) }));
    p.on("message", (m: { type?: string; url?: string; invite?: string | null; message?: string }) => {
      if (m.type === "ready") resolve({ url: m.url!, invite: m.invite ?? null });
      else if (m.type === "error") reject(new Error(m.message));
    });
    p.once("exit", (code) => {
      if (instance === p) instance = null;
      if (!quitting && code !== 0) reject(new Error(`instance exited (${code})`));
    });
  });
}

// ── window ─────────────────────────────────────────────────────────────────────────────────────────
function createWindow(page: string) {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: join(ROOT, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  w.webContents.on("will-redirect", (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  // The mouse's side buttons (and the keyboard's Back / Forward keys) on Windows: the page walks its history.
  w.on("app-command", (_e, cmd) => {
    if (cmd === "browser-backward" || cmd === "browser-forward") w.webContents.send("ddn:navigate", cmd === "browser-backward" ? "back" : "forward");
  });
  w.once("ready-to-show", () => {
    if (!process.env.DDN_DESKTOP_HIDDEN && !process.argv.includes(HIDDEN_ARG)) w.show();
  });
  w.on("closed", () => {
    if (win === w) win = null;
  });
  void w.loadURL(`${ORIGIN}${page}`);
  return w;
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    win = createWindow(server ? "/" : "/start/start.html");
    win.once("ready-to-show", () => win?.show());
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// ── tray ───────────────────────────────────────────────────────────────────────────────────────────
const pct = (x: { done: number; total: number }) => (x.total ? Math.floor((x.done / x.total) * 100) : 0);
export function trayText(b: typeof busy): string {
  if (!b.busy) return `${APP_NAME}: idle`;
  const parts = [];
  if (b.up.n) parts.push(`uploading ${b.up.n} (${pct(b.up)}%)`);
  if (b.down.n) parts.push(`downloading ${b.down.n} (${pct(b.down)}%)`);
  return `${APP_NAME}: ${parts.join(", ")}`;
}

// ── updates (installed only on the user's click; see shell/updates.ts) ─────────────────────────────
/** This copy: from build-info.json written by package.ts (absent in a dev run). */
function ownBuild(): { version: string; build: string; commit: string | null } {
  try {
    return JSON.parse(readFileSync(join(ROOT, "build-info.json"), "utf8")) as { version: string; build: string; commit: string | null };
  } catch {
    return { version: app.getVersion(), build: "dev", commit: null };
  }
}
let update: AvailableBuild | null = null;
let notifiedCommit = "";
/**
 * The program that installs a .deb with admin rights: pkexec (the system password dialog). Tests (CI):
 * DDN_DESKTOP_DEB_ELEVATE names another one (e.g. "sudo -n") — pkexec needs a desktop session.
 */
const debElevate = (): string | null => process.env.DDN_DESKTOP_DEB_ELEVATE || findPkexec();
const kind = () => installKind({ platform: process.platform, appImage: process.env.APPIMAGE, execPath: process.execPath, packaged: app.isPackaged });
async function checkUpdates(manual = false): Promise<{ current: ReturnType<typeof ownBuild>; available: AvailableBuild | null; kind: string }> {
  const own = ownBuild();
  if (!manual && !settings.checkUpdates) return { current: own, available: null, kind: kind() };
  const b = await latestBuild((u, i) => net.fetch(u, i), process.env.DDN_DESKTOP_UPDATES_API).catch(() => null);
  update = isNewer(own, b) ? b : null;
  if (update && update.commit !== notifiedCommit && Notification.isSupported()) {
    notifiedCommit = update.commit;
    new Notification({ title: "A new version of discordrive is available", body: "Open discordrive → Settings → About to download it." }).show();
  }
  paintTray();
  return { current: own, available: update, kind: kind() };
}
/** The installer downloaded and checked in this run (only this file may be installed). */
let downloaded: { path: string; sha256: string } | null = null;
/** Started once the agent and the instance have stopped (before-quit), so the installer meets no running copy. */
let runOnQuit: (() => void) | null = null;
let debLastError = "";
async function downloadUpdate(): Promise<{ path: string; hint: string; busy: boolean; inPlace: boolean; command?: string }> {
  if (!update) throw new Error("no new version");
  const a = assetFor(kind(), update.assets);
  if (!a) throw new Error("no installer for this system in the release");
  // Already downloaded and checked before (an earlier run): the same file, if it still matches the release's sum.
  const known = (() => {
    try {
      return JSON.parse(readFileSync(join(DATA(), "update-downloaded.json"), "utf8")) as { path: string; sha256: string; commit: string };
    } catch {
      return null;
    }
  })();
  let path: string;
  if (known && known.commit === update.commit && existsSync(known.path) && (await sha256File(known.path).catch(() => "")) === known.sha256) path = known.path;
  else {
    // Progress to the window (Settings → App): bytes so far, at most every 250 ms.
    let last = 0;
    path = await downloadVerified((u, i) => net.fetch(u, i), update, a, app.getPath("downloads"), (done, total) => {
      if (Date.now() - last < 250 && done < total) return;
      last = Date.now();
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("ddn:update-progress", { done, total });
    });
  }
  downloaded = { path, sha256: await sha256File(path) };
  writeFileSync(join(DATA(), "update-downloaded.json"), JSON.stringify({ ...downloaded, commit: update.commit }) + "\n");
  const inPlace = canInstallInPlace(kind(), process.env.APPIMAGE, debElevate());
  // Transfers running: say so, do not stop them (the user installs when it suits).
  return { path, hint: installHint(kind(), path, inPlace), busy: busy.busy, inPlace, ...(kind() === "deb" && !inPlace ? { command: debTerminalCommand(path) } : {}) };
}
/**
 * "Install and restart": Windows runs the downloaded installer silently in update mode in this copy's
 * folder once the app has closed (shortcuts and pins stay, the data folder is not touched) and the
 * installer starts the app again; an AppImage is replaced by the new file and restarted. Running
 * transfers: the user is asked first, as on Quit. Returns false when the user kept the app running.
 */
async function installUpdate(ask = true): Promise<boolean> {
  const k = kind();
  if (!downloaded) throw new Error("download the new version first");
  if (!canInstallInPlace(k, process.env.APPIMAGE, debElevate())) throw new Error(k === "deb" ? `no pkexec on this system: install it in a terminal: ${debTerminalCommand(downloaded.path)}` : "this copy cannot update itself: install the downloaded file");
  // The same file that was checked against SHA256SUMS (the Downloads folder is writable by other programs).
  if ((await sha256File(downloaded.path).catch(() => "")) !== downloaded.sha256) {
    downloaded = null;
    throw new Error("the downloaded file changed after it was checked: download it again");
  }
  if (ask && busy.busy) {
    const pl = app.getLocale().startsWith("pl");
    const r = await dialog.showMessageBox({
      type: "warning",
      buttons: pl ? ["Zainstaluj mimo to", "Później"] : ["Install anyway", "Later"],
      defaultId: 1,
      cancelId: 1,
      message: pl ? "Trwają transfery" : "Transfers are still running",
      detail: `${trayText(busy)}. ${pl ? "Niedokończone pobierania wznowią się po ponownym uruchomieniu; niedokończone wysyłki — gdy wyślesz ten sam plik jeszcze raz." : "Unfinished downloads continue after the restart; unfinished uploads continue when you upload the same file again."}`,
    });
    if (r.response !== 0) return false;
  }
  const file = downloaded.path;
  if (k === "deb") {
    // dpkg with admin rights while this copy still runs (a .deb replaces the files of a running app safely:
    // the running process keeps the old ones), then the app starts again as the new version. A cancelled
    // password dialog (pkexec exit 126/127) or a dpkg error: the app keeps running and says so.
    const [prog, ...pre] = debElevate()!.split(/\s+/);
    const c = debInstallCommand(file, prog!)!;
    const code = await new Promise<number>((res) => {
      const p = spawn(c.file, [...pre, ...c.args], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr?.on("data", (d) => (err += String(d)));
      p.on("error", () => res(-1));
      p.on("close", (x) => {
        if (x) debLastError = err.trim().split("\n").slice(-3).join(" ");
        res(x ?? -1);
      });
    });
    if (code !== 0) {
      throw new Error(code === 126 || code === 127 ? "the installation was cancelled (no password given)" : `dpkg failed (${code}): ${debLastError || "see the terminal"}; or in a terminal: ${debTerminalCommand(file)}`);
    }
    // The same switches as this start (e.g. --no-sandbox where the system needs it), plus --updated.
    app.relaunch({ args: [...process.argv.slice(1).filter((x) => x !== "--updated" && !x.startsWith("--hidden")), "--updated"] });
    quitting = true;
    app.quit();
    return true;
  }
  if (k === "appimage") {
    const target = process.env.APPIMAGE!;
    replaceAppImage(file, target);
    app.relaunch({ execPath: target, args: [] });
  } else {
    const c = nsisUpdateCommand(file, dirname(process.execPath));
    runOnQuit = () => {
      // windowsVerbatimArguments: NSIS reads /D= raw (a path with spaces, no quotes); argv0 is quoted here.
      const p = spawn(c.file, c.args, { argv0: c.argv0, detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false });
      p.on("error", () => null);
      p.unref();
    };
  }
  quitting = true;
  app.quit();
  return true;
}
/**
 * Tests (CI, Windows): with DDN_DESKTOP_UPDATE_SELFTEST=<report file> the app checks for an update at
 * start; when there is one it downloads and installs it the same way as the buttons do, otherwise it
 * writes which build it is and quits.
 */
async function updateSelftest(report: string) {
  const own = ownBuild();
  const write = (o: object) => writeFileSync(report, JSON.stringify({ own, argv: process.argv.slice(1), ...o }, null, 1));
  try {
    const r = await checkUpdates(true);
    if (!r.available) {
      write({ stage: "current" });
      quitting = true;
      app.quit();
      return;
    }
    const d = await downloadUpdate();
    write({ stage: "installing", to: r.available.commit, file: d.path });
    await installUpdate(false);
  } catch (e) {
    write({ stage: "error", error: String(e) });
    quitting = true;
    app.quit();
  }
}
function wireUpdates() {
  const fromApp = (e: IpcMainInvokeEvent) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
  };
  ipcMain.handle("ddn:update-check", (e) => (fromApp(e), checkUpdates(true)));
  ipcMain.handle("ddn:update-download", async (e) => (fromApp(e), downloadUpdate()));
  ipcMain.handle("ddn:update-install", async (e) => (fromApp(e), installUpdate()));
  // Settings → Desktop app: update checks, autostart, downloads folder (a folder picked in the system dialog).
  ipcMain.handle("ddn:app-settings", (e, patch: unknown) => {
    fromApp(e);
    const p = (patch && typeof patch === "object" ? patch : {}) as { checkUpdates?: unknown; autostart?: unknown; downloadsDir?: unknown; keyring?: unknown; vdisk?: unknown; vdiskCacheGb?: unknown; vdiskWrite?: unknown };
    if (VDISK_OS && typeof p.vdisk === "boolean" && p.vdisk !== (settings.vdisk === true)) {
      settings.vdisk = p.vdisk;
      vdiskState = p.vdisk ? "mounting" : "off";
      agent?.postMessage({ type: "vdisk", ...vdiskInit().vdisk! });
    }
    if (process.platform === "linux" && typeof p.vdiskWrite === "boolean" && p.vdiskWrite !== (settings.vdiskWrite === true)) {
      settings.vdiskWrite = p.vdiskWrite;
      if (settings.vdisk === true) agent?.postMessage({ type: "vdisk", ...vdiskInit().vdisk! });
    }
    if (VDISK_OS && typeof p.vdiskCacheGb === "number" && Number.isFinite(p.vdiskCacheGb) && p.vdiskCacheGb >= 1 && p.vdiskCacheGb <= 10_000) {
      settings.vdiskCacheBytes = Math.round(p.vdiskCacheGb) * 1024 ** 3;
      agent?.postMessage({ type: "vdisk", ...vdiskInit().vdisk! });
    }
    if (typeof p.checkUpdates === "boolean") settings.checkUpdates = p.checkUpdates;
    // Keyring on again (used from the next start: the keys move into it then) or off.
    if (p.keyring === "ask" || p.keyring === "file") settings.keyring = p.keyring;
    if (typeof p.autostart === "boolean" && p.autostart !== settings.autostart) {
      settings.autostart = p.autostart;
      setAutostart(autostartEnv(), p.autostart);
      paintTray();
    }
    if (typeof p.downloadsDir === "string" && p.downloadsDir === pickedFolder) {
      settings.downloadsDir = p.downloadsDir;
      agent?.postMessage({ type: "downloads-dir", dir: p.downloadsDir });
    }
    saveSettings(DATA(), settings);
    return {
      checkUpdates: settings.checkUpdates,
      autostart: settings.autostart,
      downloadsDir: downloadsDir(),
      keyring: settings.keyring,
      platform: process.platform,
      ...(VDISK_OS
        ? { vdisk: { on: settings.vdisk === true, write: settings.vdiskWrite === true, writable: !VDISK_WIN, queue: vdiskQueue, cacheGb: Math.round((settings.vdiskCacheBytes ?? 10 * 1024 ** 3) / 1024 ** 3), mountpoint: VDISK_DIR(), unavailable: vdiskUnavailable(), state: vdiskState } }
        : {}),
    };
  });
  ipcMain.on("ddn:open-path", (e, p: unknown) => {
    // Only the installer this app just downloaded and checked.
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || typeof p !== "string" || !update) return;
    if (normalize(p).startsWith(normalize(app.getPath("downloads")) + sep) && update.assets.some((a) => p.endsWith(a.name))) void shell.openPath(p);
  });
  if (process.env.DDN_DESKTOP_UPDATE_SELFTEST) return;
  setTimeout(() => void checkUpdates(), 30_000);
  setInterval(() => void checkUpdates(), CHECK_EVERY_MS);
}

let paused = false;
function paintTray() {
  if (!tray) return;
  tray.setToolTip(trayText(busy));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayText(busy), enabled: false },
      ...(update ? [{ label: "New version available…", click: showWindow }] : []),
      { type: "separator" },
      { label: "Open", click: showWindow },
      {
        label: paused ? "Resume transfers" : "Pause transfers",
        click: () => {
          paused = !paused;
          agent?.postMessage({ type: "pause", on: paused });
          paintTray();
        },
      },
      { type: "separator" },
      {
        label: "Start at log-on",
        type: "checkbox",
        checked: settings.autostart,
        click: (i) => {
          settings.autostart = i.checked;
          saveSettings(DATA(), settings);
          setAutostart(autostartEnv(), i.checked);
        },
      },
      { label: "Quit", click: () => void quitAsk() },
    ]),
  );
}

function trayIcon() {
  const f = join(ROOT, "static", "tray.png");
  return existsSync(f) ? nativeImage.createFromPath(f) : nativeImage.createEmpty();
}

async function quitAsk() {
  if (busy.busy) {
    const r = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Quit anyway", "Keep running"],
      defaultId: 1,
      cancelId: 1,
      message: "Transfers are still running",
      detail: `${trayText(busy)}. Unfinished downloads continue from where they stopped at the next start; unfinished uploads continue when you upload the same file again.`,
    });
    if (r.response !== 0) return;
  }
  quitting = true;
  app.quit();
}

function autostartEnv(): AutostartEnv {
  return { platform: process.platform, exec: process.env.APPIMAGE ?? process.execPath, appId: APP_ID, appName: APP_NAME, login: app };
}

/**
 * Is the OS key store usable? Windows (DPAPI) and macOS (Keychain) always; Linux only with a secret
 * service (GNOME Keyring / KWallet), not with Electron's "basic_text" fallback (a fixed, public key). The
 * check gets a few seconds: a session without a key store can leave it waiting on D-Bus.
 */
async function keyStoreKind(waitMs = 5000): Promise<"os" | "file"> {
  // Tests: DDN_DESKTOP_TEST_KEYSTORE=file|os decides without a real keyring (a keyring that appears later).
  const forced = process.env.DDN_DESKTOP_TEST_KEYSTORE_FILE;
  if (forced && existsSync(forced)) return readFileSync(forced, "utf8").trim() === "os" ? "os" : "file";
  const ok = await Promise.race([safeStorage.isAsyncEncryptionAvailable().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), waitMs))]);
  if (!ok) return "file";
  if (process.platform === "linux" && ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())) return "file";
  return "os";
}

/**
 * Linux: the keyring only when it makes sense. Keys sealed by it: always ask it (a locked one asks to unlock;
 * Cancel shows "The keyring is locked" in the window). No keys sealed yet and no default keyring: gnome-keyring
 * would open its own "create a keyring" window; the app explains first and remembers a "no" (keys in an
 * owner-only file, Settings → App can turn the keyring on again). The user refused: no keyring, no window.
 */
async function chooseKeyStore(): Promise<"os" | "file"> {
  if (process.platform !== "linux") return keyStoreKind();
  const keys = keysProtection(join(DATA(), "agent", "keys.bin"));
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((res, rej) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += String(d)));
      p.on("error", rej);
      p.on("close", (c) => (c === 0 ? res(out) : rej(new Error(`exit ${c}`))));
    });
  const plan = keyringPlan({ platform: process.platform, choice: settings.keyring, keys, defaultKeyring: keys === "S" ? null : await hasDefaultKeyring(run) });
  if (plan === "file") return "file";
  if (plan === "explain" && !process.env.DDN_DESKTOP_SMOKE) {
    const pl = app.getLocale().startsWith("pl");
    const r = process.env.DDN_DESKTOP_TEST_KEYRING_ANSWER ? { response: process.env.DDN_DESKTOP_TEST_KEYRING_ANSWER === "no" ? 1 : 0 } : await dialog.showMessageBox({
      type: "question",
      buttons: pl ? ["Utwórz magazyn kluczy", "Nie, trzymaj klucze w pliku"] : ["Create a keyring", "No, keep the keys in a file"],
      defaultId: 0,
      cancelId: 1,
      message: pl ? "discordrive chce zapisać klucze konta w systemowym magazynie kluczy" : "discordrive would like to keep the account's keys in the system keyring",
      detail: pl
        ? "Ten system nie ma jeszcze magazynu kluczy (keyring). Za chwilę system poprosi o hasło do nowego magazynu (okno \u201eChoose password for new keyring\u201d). Bez niego klucze leżą w pliku, który może odczytać tylko Twój użytkownik. Wybór zmienisz w Ustawieniach → Aplikacja."
        : "This system has no keyring yet. The system will now ask for a password for a new one (the \u201cChoose password for new keyring\u201d window). Without it the keys stay in a file only your user can read. You can change this in Settings → App.",
    });
    if (r.response !== 0) {
      settings.keyring = "file";
      saveSettings(DATA(), settings);
      // Chromium chose its password store at start (the keyring): left so, its first cookie or network use
      // in this session opens the keyring's "create" window and the network waits for it (a server could not
      // be reached until the window was closed). The switch that keeps it off the keyring is read only at
      // start, so start again now, with the choice saved (nothing runs yet: no window, agent or instance).
      if (process.env.DDN_DESKTOP_DEBUG || process.env.DDN_DESKTOP_DATA) console.error("[ddn] keyring refused: starting again without it");
      app.relaunch({ ...(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {}), args: [...process.argv.slice(1).filter((x) => !x.startsWith("--password-store")), "--password-store=basic"] });
      app.exit(0);
      return new Promise<never>(() => {});
    }
  }
  const k = await keyStoreKind();
  // The create / unlock window was cancelled and there are no sealed keys: remember it, do not ask at every start.
  if (k === "file" && keys !== "S" && plan === "explain") {
    settings.keyring = "file";
    saveSettings(DATA(), settings);
  }
  return k;
}

// ── first start / server choice ────────────────────────────────────────────────────────────────────
function fromStartPage(e: IpcMainInvokeEvent) {
  const f = e.senderFrame;
  if (!f || !win || e.sender !== win.webContents || f !== win.webContents.mainFrame || !isAppUrl(f.url) || !new URL(f.url).pathname.startsWith("/start/")) throw new Error("not allowed");
}

async function useServer(s: { url: string; mode: string; kind: "remote" | "local" }) {
  if (!(MODES as readonly string[]).includes(s.mode)) throw new Error(`this app has no ${s.mode} mode`);
  server = s;
  // The agent reads the server from the stored account; a new choice starts it afresh.
  agent?.postMessage({ type: "quit" });
  agent = startAgent();
}

async function health(url: string): Promise<{ mode: string; signup: string }> {
  const r = await net.fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
    throw new Error(`cannot reach ${url}: ${e.message}`);
  });
  if (!r.ok) throw new Error(`${url} is not a discordrive instance (HTTP ${r.status})`);
  const j = (await r.json().catch(() => null)) as { ok?: boolean; mode?: string; signup?: string } | null;
  if (!j?.ok || typeof j.mode !== "string") throw new Error(`${url} is not a discordrive instance`);
  return { mode: j.mode, signup: j.signup ?? "invite" };
}

function wireSetupIpc() {
  ipcMain.handle("ddn:setup-connect", async (e, input: unknown) => {
    fromStartPage(e);
    if (typeof input !== "string" || input.length > 2000) throw new Error("bad address");
    const url = normaliseServerUrl(input);
    const h = await health(url);
    settings.servers = [{ kind: "remote", url, mode: h.mode, addedAt: Date.now() }];
    settings.active = 0;
    saveSettings(DATA(), settings);
    await useServer({ url, mode: h.mode, kind: "remote" });
    void win?.loadURL(`${ORIGIN}/`);
    return true;
  });
  ipcMain.handle("ddn:setup-local", async (e) => {
    fromStartPage(e);
    const r = await startInstance();
    settings.servers = [{ kind: "local", url: "", mode: "metadata-only", addedAt: Date.now() }];
    settings.active = 0;
    settings.localTermsAt = Date.now();
    saveSettings(DATA(), settings);
    localInvite = r.invite;
    await useServer({ url: r.url, mode: "metadata-only", kind: "local" });
    void win?.loadURL(`${ORIGIN}/`);
    return true;
  });
  // "Unlock and try again" (keys sealed, the keyring did not open them): ask the keyring again now. It works
  // now (unlocked meanwhile, or its answer came after the start's 5 s): the agent starts again with it and the
  // window reloads (true). Still not: false (the window says so). A locked keyring asks to unlock here.
  ipcMain.handle("ddn:keystore-retry", async (e) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
    const k = await keyStoreKind(process.env.DDN_DESKTOP_TEST_KEYSTORE_WAIT ? Number(process.env.DDN_DESKTOP_TEST_KEYSTORE_WAIT) : 30_000);
    if (k !== "os") return false;
    sealerKind = "os";
    agent?.postMessage({ type: "quit" });
    agent = startAgent();
    await agentReady;
    setTimeout(() => win?.webContents.reload(), 300);
    return true;
  });
  ipcMain.handle("ddn:first-account-made", (e) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
    if (server?.kind === "local") {
      localInvite = null;
      instance?.postMessage({ type: "close-signup" });
    }
    return true;
  });
  // Copy (rescue kit, pairing code, share links, invite codes): the window gets no permissions at all, so
  // the web Clipboard API is refused there; the main process writes the text instead. Write only, plain
  // text, from the app's own frames, bounded (a rescue kit with many channels is a few KB).
  ipcMain.handle("ddn:copy-text", (e, text: unknown) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
    if (typeof text !== "string" || text.length > MAX_COPY_CHARS) throw new Error("bad text");
    clipboard.writeText(text);
    return true;
  });
  ipcMain.on("ddn:show-in-folder", (e, p: unknown) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || typeof p !== "string" || p.length > 4096) return;
    // Only files the agent wrote: under the downloads folder.
    const dl = normalize(downloadsDir());
    if (normalize(p).startsWith(dl + sep)) shell.showItemInFolder(p);
  });
  ipcMain.on("ddn:open-file", (e, p: unknown) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || typeof p !== "string" || p.length > 4096) return;
    // Only files the agent wrote (under the downloads folder), and only media: never something executable.
    const dl = normalize(downloadsDir());
    if (normalize(p).startsWith(dl + sep) && /\.(mp4|m4v|mov|mkv|webm|avi|wmv|3gp|ts|mts|m2ts|mp3|m4a|flac|ogg|opus|wav)$/i.test(p)) void shell.openPath(p);
  });
  ipcMain.handle("ddn:pick-folder", async (e) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || !win) throw new Error("not allowed");
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    // Only a folder the user picked here may become the downloads folder.
    pickedFolder = r.canceled ? null : (r.filePaths[0] ?? null);
    return pickedFolder;
  });
}
/** Longest text the window may copy (a rescue kit lists every channel's webhook). */
const MAX_COPY_CHARS = 256 * 1024;
let localInvite: string | null = null;
let pickedFolder: string | null = null;
/** Where downloads go: Settings, else the system Downloads folder (tests: DDN_DESKTOP_DOWNLOADS). */
const downloadsDir = () => settings.downloadsDir ?? process.env.DDN_DESKTOP_DOWNLOADS ?? app.getPath("downloads");

// ── smoke test (CI) ────────────────────────────────────────────────────────────────────────────────
/**
 * Writes a JSON report to $DDN_DESKTOP_SMOKE and quits: the start page loaded; "This computer only"
 * started the instance and loaded the web app, which reached the agent; the page has no Node; navigation
 * outside the app is blocked; the agent outlives the closed window.
 */
async function smoke() {
  const { writeFileSync } = await import("node:fs");
  const report: Record<string, unknown> = { electron: process.versions.electron, node: process.versions.node, keyStore: sealerKind };
  const js = (s: string) => win!.webContents.executeJavaScript(s);
  const until = async (s: string, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await js(s).catch(() => null);
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    report.startPage = await until(`!!document.querySelector('[data-ddn=start-local]')`);
    await js(`document.querySelector('[data-ddn=start-local]').click(); document.querySelector('[data-ddn=start-accept]').click(); 1`);
    report.webApp = await until(`location.pathname === '/' && !!document.querySelector('[data-ddn=create]')`, 60_000);
    report.agentReply = await until(`window.ddnCore && window.ddnCore.capabilities().then(c => c)`);
    report.instance = server;
    report.pageHasNode = await js("typeof require !== 'undefined' || typeof process !== 'undefined'");
    await js("location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 500));
    report.urlAfterNavigation = win!.webContents.getURL();
    const pid = agent?.pid;
    win!.close();
    await new Promise((r) => setTimeout(r, 1000));
    report.agentAliveAfterClose = !!agent && agent.pid === pid && pid !== undefined;
    report.ok =
      !!report.startPage &&
      !!report.webApp &&
      (report.agentReply as { platform?: string } | null)?.platform === "desktop" &&
      report.pageHasNode === false &&
      isAppUrl(String(report.urlAfterNavigation)) &&
      report.agentAliveAfterClose === true;
  } catch (e) {
    report.error = String(e);
    report.ok = false;
  }
  writeFileSync(process.env.DDN_DESKTOP_SMOKE!, JSON.stringify(report, null, 1));
  quitting = true;
  app.quit();
}

async function refuseWithoutSandbox() {
  const pl = app.getLocale().startsWith("pl");
  const cmd = appArmorCommand();
  const report = process.env.DDN_DESKTOP_SANDBOX_REPORT;
  if (report) {
    // CI: the refusal itself is the check.
    (await import("node:fs")).writeFileSync(report, JSON.stringify({ refused: true }));
    app.exit(3);
    return;
  }
  const r = await dialog.showMessageBox({
    type: "error",
    title: APP_NAME,
    message: pl ? "Ten system blokuje piaskownicę (sandbox) aplikacji w wersji AppImage" : "This system blocks the app's sandbox in the AppImage",
    detail: pl
      ? "Ubuntu 24.04 i nowsze nie pozwalają programom AppImage na przestrzenie nazw użytkownika, których potrzebuje piaskownica Chromium, a bez niej aplikacja się nie uruchomi.\n\nNajprościej: zainstaluj pakiet .deb (sam dodaje potrzebny profil AppArmor).\n\nAlbo zezwól tej wersji AppImage jednym poleceniem (wymaga sudo; skopiuje się do schowka):\n\n" + cmd
      : "Ubuntu 24.04 and newer do not let AppImages use the user namespaces Chromium's sandbox needs, and the app does not run without it.\n\nEasiest: install the .deb package (it adds the AppArmor profile it needs).\n\nOr allow this AppImage with one command (needs sudo; copied to the clipboard):\n\n" + cmd,
    buttons: [pl ? "Pobierz .deb" : "Get the .deb", pl ? "Skopiuj polecenie" : "Copy the command", pl ? "Zamknij" : "Close"],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 0) await shell.openExternal("https://github.com/Magiszonekk/discordrive/releases");
  if (r.response === 1) clipboard.writeText(cmd);
  app.exit(0);
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────────
const single = app.requestSingleInstanceLock();
if (!single) {
  // Another copy runs: it shows its window (second-instance) and this one ends.
  if (process.env.DDN_DESKTOP_DEBUG || process.env.DDN_DESKTOP_DATA) console.error("[ddn] another instance holds the lock; exiting");
  app.quit();
}
else {
  app.on("second-instance", () => showWindow());
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (e) => e.preventDefault());
  });
  void app.whenReady().then(async () => {
    // AppImage without Chromium's sandbox (blocked user namespaces): explain and stop, never run unsandboxed.
    if (appImageWithoutSandbox({ platform: process.platform, appImage: process.env.APPIMAGE, noSandbox: app.commandLine.hasSwitch("no-sandbox") })) {
      await refuseWithoutSandbox();
      return;
    }
    const dbg = (m: string) => process.env.DDN_DESKTOP_DEBUG && console.error(`[ddn] ${m}`);
    settings = loadSettings(DATA());
    dbg("settings loaded");
    // Started by the installer after an in-place update: note which build this is now (About, tests).
    if (process.argv.includes("--updated")) writeFileSync(join(DATA(), "last-update.json"), JSON.stringify({ ...ownBuild(), at: new Date().toISOString() }) + "\n");
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    protocol.handle(SCHEME, async (req) => {
      // The web app's config (an instance serves the same file): where its server is and, on the built-in
      // instance before its first account, the one-shot sign-up code (the app fills it in, nobody types it).
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname.startsWith(STREAM_PREFIX)) return streamResponse(req, reqUrl);
      if (reqUrl.pathname === "/config.js") {
        const cfg = { serverUrl: server?.url ?? null, mode: server?.mode ?? null, desktop: { local: server?.kind === "local", invite: server?.kind === "local" ? localInvite : null } };
        return new Response(`window.DDN_CONFIG=${JSON.stringify(cfg)};\n`, { headers: { "content-type": "text/javascript", "content-security-policy": csp(), "cache-control": "no-store" } });
      }
      const p = staticPath(req.url);
      if (!p || !existsSync(p)) return new Response("not found", { status: 404 });
      const r = await net.fetch(pathToFileURL(p).toString());
      const h = new Headers(r.headers);
      h.set("content-security-policy", csp());
      h.set("x-content-type-options", "nosniff");
      h.set("referrer-policy", "no-referrer");
      return new Response(r.body, { status: r.status, headers: h });
    });
    ipcMain.on("ddn:hello", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && e.senderFrame === w.webContents.mainFrame && isAppUrl(e.senderFrame.url)) connectWindow(w);
    });
    wireSetupIpc();
    if (!process.env.DDN_DESKTOP_SMOKE) wireUpdates();
    sealerKind = await chooseKeyStore();
    dbg(`key store: ${sealerKind}`);
    // First start: autostart on by default.
    if (!existsSync(join(DATA(), "desktop-settings.json"))) {
      saveSettings(DATA(), settings);
      if (settings.autostart && !process.env.DDN_DESKTOP_SMOKE) setAutostart(autostartEnv(), true);
    } else if (settings.autostart !== autostartOn(autostartEnv()) && !process.env.DDN_DESKTOP_SMOKE) setAutostart(autostartEnv(), settings.autostart);
    // The chosen server: the built-in instance starts first (new port at every start).
    const s = settings.servers[settings.active];
    if (s?.kind === "local") {
      const r = await startInstance();
      localInvite = r.invite;
      server = { url: r.url, mode: "metadata-only", kind: "local" };
    } else if (s) server = { url: s.url, mode: s.mode, kind: "remote" };
    dbg(`server: ${JSON.stringify(server)}`);
    agent = startAgent();
    tray = new Tray(trayIcon());
    dbg("tray");
    tray.on("click", showWindow);
    paintTray();
    win = createWindow(server ? "/" : "/start/start.html");
    if (process.env.DDN_DESKTOP_SMOKE) win.webContents.once("did-finish-load", () => void smoke());
    if (process.env.DDN_DESKTOP_UPDATE_SELFTEST) void updateSelftest(process.env.DDN_DESKTOP_UPDATE_SELFTEST);
  });
  // Closing the window does not end the app: the agent keeps transferring and syncing (tray: Quit).
  app.on("window-all-closed", () => {
    if (process.env.DDN_DESKTOP_QUIT_ON_CLOSE) app.quit();
  });
  let stopped = false;
  const qdbg = (m: string) => (process.env.DDN_DESKTOP_DEBUG || process.env.DDN_DESKTOP_DATA) && console.error(`[ddn] ${m}`);
  app.on("before-quit", (e) => {
    qdbg(`before-quit: quitting=${quitting} busy=${busy.busy} stopped=${stopped}`);
    if (!quitting && busy.busy) {
      e.preventDefault();
      void quitAsk();
      return;
    }
    quitting = true;
    if (stopped) return;
    // The agent and the built-in instance stop first (database closed, journals flushed); the app ends
    // after them, so a new start never meets a half-closed one (at most 5 s).
    e.preventDefault();
    const ends = [agent, instance].filter((p): p is UtilityProcess => !!p && p.pid !== undefined).map((p) => new Promise<void>((r) => (p.once("exit", () => r()), p.postMessage({ type: "quit" }))));
    void Promise.race([Promise.all(ends).then(() => "children exited"), new Promise((r) => setTimeout(() => r("5 s timeout"), 5000))]).then((why) => {
      qdbg(`children stopped: ${why}`);
      stopped = true;
      for (const p of [agent, instance]) p?.kill();
      // Once, even when Quit was asked twice (a second click while the first quit waits for the children).
      const run = runOnQuit;
      runOnQuit = null;
      run?.();
      app.quit();
    });
  });
}
