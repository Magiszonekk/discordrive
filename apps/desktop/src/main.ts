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
import { app, BrowserWindow, Menu, clipboard, MessageChannelMain, Notification, Tray, dialog, ipcMain, nativeImage, net, protocol, safeStorage, session, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { ORIGIN, SCHEME, isAppUrl, staticPath as staticPathIn } from "./shell/paths.js";
import { pathToFileURL } from "node:url";
import { DISCORD_ORIGINS } from "@ddv4/metadata-client/node";
import { autostartOn, setAutostart, HIDDEN_ARG, type AutostartEnv } from "./shell/autostart.js";
import { loadSettings, normaliseServerUrl, saveSettings, type DesktopSettings } from "./shell/settings.js";
import type { AgentInit } from "./agent.js";
import { appArmorCommand, appImageWithoutSandbox } from "./shell/sandbox.js";
import { CHECK_EVERY_MS, assetFor, downloadVerified, installHint, installKind, isNewer, latestBuild, type AvailableBuild } from "./shell/updates.js";

const APP_ID = "discordrive";
const APP_NAME = "discordrive";
/** Built app files: static/ (start page), web/<mode>/ (the web app); nothing outside these is served. */
const ROOT = __dirname;
const MODES = ["metadata-only", "e2ee", "plain"] as const;

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Test runs (CI) put the data folder elsewhere and may hide the window. */
if (process.env.DDN_DESKTOP_DATA) app.setPath("userData", process.env.DDN_DESKTOP_DATA);
const DATA = () => app.getPath("userData");

let win: BrowserWindow | null = null;
let agent: UtilityProcess | null = null;
let instance: UtilityProcess | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
/** The server the app talks to now (local: its address at this start). */
let server: { url: string; mode: string; kind: "remote" | "local" } | null = null;
let quitting = false;
let busy = { busy: false, up: { n: 0, done: 0, total: 0 }, down: { n: 0, done: 0, total: 0 } };

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

async function onAgentMessage(a: UtilityProcess, m: { type?: string; id?: number; data?: Uint8Array; busy?: boolean; kind?: string; name?: string; bytes?: number } & Record<string, unknown>) {
  if (m.type === "seal" || m.type === "unseal") {
    try {
      const data = m.type === "seal" ? await safeStorage.encryptStringAsync(Buffer.from(m.data!).toString("base64")) : Buffer.from((await safeStorage.decryptStringAsync(Buffer.from(m.data!))).result, "base64");
      a.postMessage({ type: "sealed", id: m.id, ok: true, data: new Uint8Array(data) });
    } catch (e) {
      a.postMessage({ type: "sealed", id: m.id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  } else if (m.type === "status") {
    busy = m as unknown as typeof busy;
    paintTray();
  } else if (m.type === "notify" && Notification.isSupported()) {
    const up = m.kind === "up-done";
    new Notification({ title: up ? "Upload finished" : "Download finished", body: `${m.name ?? ""} (${Math.round((m.bytes ?? 0) / 1e6)} MB)` }).show();
  }
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

// ── updates (never installed by the app; see shell/updates.ts) ─────────────────────────────────────
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
function wireUpdates() {
  const fromApp = (e: IpcMainInvokeEvent) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
  };
  ipcMain.handle("ddn:update-check", (e) => (fromApp(e), checkUpdates(true)));
  ipcMain.handle("ddn:update-download", async (e) => {
    fromApp(e);
    if (!update) throw new Error("no new version");
    const a = assetFor(kind(), update.assets);
    if (!a) throw new Error("no installer for this system in the release");
    const path = await downloadVerified((u, i) => net.fetch(u, i), update, a, app.getPath("downloads"));
    // Transfers running: say so, do not stop them (the user installs when it suits).
    return { path, hint: installHint(kind(), path), busy: busy.busy };
  });
  // Settings → Desktop app: update checks, autostart, downloads folder (a folder picked in the system dialog).
  ipcMain.handle("ddn:app-settings", (e, patch: unknown) => {
    fromApp(e);
    const p = (patch && typeof patch === "object" ? patch : {}) as { checkUpdates?: unknown; autostart?: unknown; downloadsDir?: unknown };
    if (typeof p.checkUpdates === "boolean") settings.checkUpdates = p.checkUpdates;
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
    return { checkUpdates: settings.checkUpdates, autostart: settings.autostart, downloadsDir: downloadsDir() };
  });
  ipcMain.on("ddn:open-path", (e, p: unknown) => {
    // Only the installer this app just downloaded and checked.
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || typeof p !== "string" || !update) return;
    if (normalize(p).startsWith(normalize(app.getPath("downloads")) + sep) && update.assets.some((a) => p.endsWith(a.name))) void shell.openPath(p);
  });
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
async function keyStoreKind(): Promise<"os" | "file"> {
  const ok = await Promise.race([safeStorage.isAsyncEncryptionAvailable().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
  if (!ok) return "file";
  if (process.platform === "linux" && ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())) return "file";
  return "os";
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
  ipcMain.handle("ddn:first-account-made", (e) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error("not allowed");
    if (server?.kind === "local") {
      localInvite = null;
      instance?.postMessage({ type: "close-signup" });
    }
    return true;
  });
  ipcMain.on("ddn:show-in-folder", (e, p: unknown) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || typeof p !== "string" || p.length > 4096) return;
    // Only files the agent wrote: under the downloads folder.
    const dl = normalize(downloadsDir());
    if (normalize(p).startsWith(dl + sep)) shell.showItemInFolder(p);
  });
  ipcMain.handle("ddn:pick-folder", async (e) => {
    if (!e.senderFrame || !isAppUrl(e.senderFrame.url) || !win) throw new Error("not allowed");
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    // Only a folder the user picked here may become the downloads folder.
    pickedFolder = r.canceled ? null : (r.filePaths[0] ?? null);
    return pickedFolder;
  });
}
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
if (!single) app.quit();
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
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    protocol.handle(SCHEME, async (req) => {
      // The web app's config (an instance serves the same file): where its server is and, on the built-in
      // instance before its first account, the one-shot sign-up code (the app fills it in, nobody types it).
      if (new URL(req.url).pathname === "/config.js") {
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
    sealerKind = await keyStoreKind();
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
  });
  // Closing the window does not end the app: the agent keeps transferring and syncing (tray: Quit).
  app.on("window-all-closed", () => {
    if (process.env.DDN_DESKTOP_QUIT_ON_CLOSE) app.quit();
  });
  app.on("before-quit", (e) => {
    if (!quitting && busy.busy) {
      e.preventDefault();
      void quitAsk();
      return;
    }
    quitting = true;
    agent?.postMessage({ type: "quit" });
    instance?.postMessage({ type: "quit" });
  });
}
