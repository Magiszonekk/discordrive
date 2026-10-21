// Preload of the window (sandboxed: only `electron`'s renderer modules, no Node). It gives the page one
// thing: a MessagePort straight to the agent, through which the web app talks to its core exactly as it
// talks to the worker in a browser. No other Electron or Node API reaches the page.
import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("ddnDesktop", { platform: process.platform, version: 1 });
