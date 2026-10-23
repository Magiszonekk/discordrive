// Preload of the window (sandboxed: only `electron`'s renderer modules, no Node). The page gets:
//  - a MessagePort straight to the agent, through which the web app talks to its core exactly as it
//    talks to the worker in a browser;
//  - `ddnDesktop`: a few narrow functions (paths of dropped files, show a file in its folder, pick a
//    folder, the first-start choice, copy a text to the clipboard). No other Electron or Node API reaches the page.
import { contextBridge, ipcRenderer, webUtils } from "electron";

let resolvePort: ((p: MessagePort) => void) | null = null;
const port = new Promise<MessagePort>((r) => (resolvePort = r));
ipcRenderer.on("ddn:agent-port", (e) => {
  const p = e.ports[0];
  if (p) resolvePort?.(p);
});
ipcRenderer.send("ddn:hello");

/**
 * The page gets the port by a window message (a MessagePort cannot cross contextBridge as a return value),
 * after its own scripts ran (they register the listener), so the message is never lost.
 */
const loaded = new Promise<void>((r) => (document.readyState === "loading" ? window.addEventListener("DOMContentLoaded", () => r(), { once: true }) : r()));
void Promise.all([port, loaded]).then(([p]) => window.postMessage({ ddnAgentPort: true }, location.origin, [p]));

contextBridge.exposeInMainWorld("ddnDesktop", {
  platform: process.platform,
  version: 1,
  pathsOf: (files: File[]) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  showInFolder: (path: string) => ipcRenderer.send("ddn:show-in-folder", String(path)),
  /** Open a file the agent downloaded in the system's default app (a video the window cannot play). */
  openFile: (path: string) => ipcRenderer.send("ddn:open-file", String(path)),
  pickFolder: () => ipcRenderer.invoke("ddn:pick-folder") as Promise<string | null>,
  firstAccountMade: () => ipcRenderer.invoke("ddn:first-account-made"),
  /** Keys sealed by the keyring that it did not open at the start: ask it again (true: the app reloads with it). */
  keystoreRetry: () => ipcRenderer.invoke("ddn:keystore-retry") as Promise<boolean>,
  /** Copy a text to the system clipboard (the window has no clipboard permission; the main process writes it). */
  copyText: (text: string) => ipcRenderer.invoke("ddn:copy-text", String(text)) as Promise<boolean>,
  /** Back / forward of the window (the mouse's side buttons on Windows arrive as app commands). */
  onNavigate: (cb: (dir: "back" | "forward") => void) => {
    ipcRenderer.on("ddn:navigate", (_e, dir: unknown) => {
      if (dir === "back" || dir === "forward") cb(dir);
    });
  },
  updates: {
    check: () => ipcRenderer.invoke("ddn:update-check"),
    download: () => ipcRenderer.invoke("ddn:update-download"),
    /** Progress of the download above (bytes). */
    onProgress: (cb: (p: { done: number; total: number }) => void) => {
      ipcRenderer.on("ddn:update-progress", (_e, p: { done?: unknown; total?: unknown }) => {
        if (typeof p?.done === "number" && typeof p?.total === "number") cb({ done: p.done, total: p.total });
      });
    },
    settings: (patch?: { checkUpdates?: boolean; autostart?: boolean; downloadsDir?: string; keyring?: "ask" | "file" }) => ipcRenderer.invoke("ddn:app-settings", patch ?? {}),
    open: (path: string) => ipcRenderer.send("ddn:open-path", String(path)),
    /** Install the downloaded update and restart (Windows, AppImage); false: the user chose to wait. */
    install: () => ipcRenderer.invoke("ddn:update-install") as Promise<boolean>,
  },
  setup: {
    connect: (url: string) => ipcRenderer.invoke("ddn:setup-connect", String(url)),
    local: () => ipcRenderer.invoke("ddn:setup-local"),
  },
});
