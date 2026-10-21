// Main process of the desktop app (the "shell"): the window, and later the tray, autostart, updates and
// the OS key store. It moves no data itself: transfers run in the agent (a separate Node process,
// agent.ts), so a stuck transfer never freezes the window and the agent keeps working with the window closed.
//
// Security baseline (Electron security checklist): the window has no Node (sandbox, contextIsolation,
// no nodeIntegration), loads only the app's own files from the app:// scheme, may not navigate anywhere
// else (outside links open in the system browser), may not open new windows, and gets no permissions.
import { app, BrowserWindow, MessageChannelMain, ipcMain, net, protocol, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = "app";
const ORIGIN = `${SCHEME}://ddn`;
/** Files the window may load (built web app + desktop pages); nothing outside this folder. */
const STATIC_DIR = join(__dirname, "static");

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win: BrowserWindow | null = null;
let agent: UtilityProcess | null = null;

/**
 * Is this URL one of the app's own pages? (Node's URL gives a custom scheme the opaque origin "null",
 * so compare scheme and host instead of `.origin`.)
 */
export function isAppUrl(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return u.protocol === `${SCHEME}:` && u.host === "ddn";
  } catch {
    return false;
  }
}

/** A path under STATIC_DIR for an app:// URL, or null when it would leave the folder. */
export function staticPath(url: string, root = STATIC_DIR): string | null {
  const u = new URL(url);
  if (u.host !== "ddn") return null;
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index.html";
  const full = normalize(join(root, p));
  return full.startsWith(root + sep) ? full : null;
}

/** Resolves once the agent process is running (messages posted before that may be lost). */
let agentReady: Promise<void> = Promise.resolve();

function startAgent(): UtilityProcess {
  const a = utilityProcess.fork(join(__dirname, "agent.cjs"), [], { serviceName: "discordrive agent", stdio: "inherit" });
  agentReady = new Promise((r) => a.once("spawn", () => r()));
  a.on("exit", (code) => {
    if (agent === a) agent = null;
    if (code !== 0 && !quitting) setTimeout(() => (agent = startAgent()), 1000);
  });
  return a;
}

/** Hand the window a fresh direct channel to the agent (the window asks again after a reload). */
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

function createWindow() {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
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
  w.once("ready-to-show", () => {
    if (!process.env.DDN_DESKTOP_HIDDEN) w.show();
  });
  void w.loadURL(`${ORIGIN}/index.html`);
  return w;
}

let quitting = false;

/**
 * Smoke test (CI, xvfb): the page reached the agent, the page has no Node, outside navigation is
 * blocked, and the agent outlives the closed window. Writes a JSON report to $DDN_DESKTOP_SMOKE and quits.
 */
async function smoke(w: BrowserWindow) {
  const { writeFileSync } = await import("node:fs");
  const report: Record<string, unknown> = { electron: process.versions.electron, node: process.versions.node };
  const deadline = Date.now() + 30_000;
  try {
    await new Promise<void>((r) => w.webContents.once("did-finish-load", () => r()));
    let reply: unknown = null;
    while (!reply && Date.now() < deadline) {
      reply = await w.webContents.executeJavaScript("window.ddnSmoke ?? null");
      if (!reply) await new Promise((r) => setTimeout(r, 100));
    }
    report.agentReply = reply;
    report.pageHasRequire = await w.webContents.executeJavaScript("typeof require !== 'undefined' || typeof process !== 'undefined'");
    report.bridge = await w.webContents.executeJavaScript("JSON.stringify(window.ddnDesktop)");
    await w.webContents.executeJavaScript("location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 500));
    report.urlAfterNavigation = w.webContents.getURL();
    const pid = agent?.pid;
    w.close();
    await new Promise((r) => setTimeout(r, 1000));
    report.agentAliveAfterClose = !!agent && agent.pid === pid && pid !== undefined;
    report.ok =
      (reply as { ok?: boolean } | null)?.ok === true && report.pageHasRequire === false && String(report.urlAfterNavigation).startsWith(ORIGIN) && report.agentAliveAfterClose === true;
  } catch (e) {
    report.error = String(e);
    report.ok = false;
  }
  writeFileSync(process.env.DDN_DESKTOP_SMOKE!, JSON.stringify(report, null, 1));
  app.quit();
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) win = createWindow();
    else (win.isMinimized() && win.restore(), win.focus());
  });
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (e) => e.preventDefault());
  });
  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    protocol.handle(SCHEME, (req) => {
      const p = staticPath(req.url);
      if (!p) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(p).toString()).then((r) => {
        const h = new Headers(r.headers);
        h.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        return new Response(r.body, { status: r.status, headers: h });
      });
    });
    ipcMain.on("ddn:hello", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && e.senderFrame === w.webContents.mainFrame && isAppUrl(e.senderFrame.url)) connectWindow(w);
    });
    agent = startAgent();
    win = createWindow();
    if (process.env.DDN_DESKTOP_SMOKE) void smoke(win);
  });
  // Closing the window does not end the app: the agent keeps working (the tray comes with the shell PR).
  app.on("window-all-closed", () => {
    if (process.env.DDN_DESKTOP_QUIT_ON_CLOSE) app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    agent?.kill();
  });
}
