// The agent: a Node process (Electron utilityProcess) hosting the application core (the same AppCore the
// browser runs in its worker) on the desktop platform: its own HTTP/2 connections to Discord, the tree in
// SQLite on disk, uploads read from disk, downloads written to disk. It keeps running with the window
// closed; windows connect to it through MessagePorts handed over by the main process, and speak the same
// {id, method, args} -> {id, ok, result | error} protocol as the browser worker. Every call is checked
// against the list in agent/methods.ts first.
//
// Messages from the main process (parentPort):
//   { type: "init", dataDir, downloadsDir, sealer, discordApiOrigin?, tlsCa? }   once, first
//   { type: "port" } + a MessagePort                                           a window connects
//   { type: "sealed", id, ok, data | error }                                   answer to a seal request
//   { type: "quit" }
// Messages to the main process:
//   { type: "seal" | "unseal", id, data }    the OS key store lives in the main process (safeStorage)
//   { type: "status", busy, up, down }       for the tray (what is running)
//   { type: "notify", kind, name, bytes }    a large transfer finished
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { h2Fetch } from "@ddv4/metadata-client/node";
import { AppCore, type CoreEvent } from "../../web-mo/src/app-core.js";
import { encodeBlobs } from "../../web-mo/src/rpc.js";
import { nodePlatform, type Sealer } from "./agent/node-platform.js";
import { checkCall } from "./agent/methods.js";

type Port = Electron.MessagePortMain;
export interface AgentInit {
  type: "init";
  dataDir: string;
  downloadsDir: string;
  /** "os": the main process has a working OS key store; "file": owner-only file. */
  sealer: "os" | "file";
  discordApiOrigin?: string;
  tlsCa?: string;
  /** The instance built into the app: its address at this start (new port every time). */
  serverUrl?: string;
}

const parent = process.parentPort;
let setDownloadsDir: (d: string) => void = () => {};
const ports = new Set<Port>();
let core: AppCore | null = null;
let ready: Promise<AppCore> | null = null;

// ── secrets through the main process (safeStorage) ─────────────────────────────────────────────────
let sealSeq = 0;
const sealWait = new Map<number, { ok: (b: Uint8Array) => void; err: (e: Error) => void }>();
function viaMain(type: "seal" | "unseal", data: Uint8Array): Promise<Uint8Array> {
  return new Promise((ok, err) => {
    const id = ++sealSeq;
    sealWait.set(id, { ok, err });
    parent.postMessage({ type, id, data });
  });
}
const osSealer: Sealer = { kind: "os", seal: (b) => viaMain("seal", b), open: (b) => viaMain("unseal", b) };

// ── what is running, for the tray ──────────────────────────────────────────────────────────────────
type Run = { done: number; total: number; name?: string };
const running = { up: new Map<string, Run>(), down: new Map<string, Run>() };
let statusTimer: ReturnType<typeof setTimeout> | null = null;
/** Transfers at least this big get a system notification when they end. */
const NOTIFY_BYTES = 100 * 1024 * 1024;
function pushStatus() {
  statusTimer ??= setTimeout(() => {
    statusTimer = null;
    const sum = (m: Map<string, Run>) => [...m.values()].reduce((a, x) => ({ done: a.done + x.done, total: a.total + x.total }), { done: 0, total: 0 });
    parent.postMessage({ type: "status", busy: running.up.size + running.down.size > 0, up: { n: running.up.size, ...sum(running.up) }, down: { n: running.down.size, ...sum(running.down) } });
  }, 250);
}
function track(e: CoreEvent) {
  if (e.type !== "upload-progress" && e.type !== "download-progress") return;
  const m = e.type === "upload-progress" ? running.up : running.down;
  if (e.total > 0 && e.done >= e.total) {
    const was = m.get(e.token);
    m.delete(e.token);
    if (e.total >= NOTIFY_BYTES) parent.postMessage({ type: "notify", kind: e.type === "upload-progress" ? "up-done" : "down-done", name: e.name ?? was?.name ?? "", bytes: e.total });
  } else m.set(e.token, { done: e.done, total: e.total, name: e.name });
  pushStatus();
}

function broadcast(event: CoreEvent) {
  for (const p of ports) p.postMessage({ event });
}

async function start(init: AgentInit): Promise<AppCore> {
  const f = h2Fetch(init.tlsCa ? { tls: { ca: init.tlsCa } } : {});
  const platform = nodePlatform({
    dataDir: init.dataDir,
    downloadsDir: init.downloadsDir,
    discordFetch: f,
    // The guard's second download connection: a separate session of the pool.
    cdnLanes: [f.onLane(1)],
    sealer: init.sealer === "os" ? osSealer : undefined,
    serverUrl: init.serverUrl ? () => init.serverUrl : undefined,
  });
  setDownloadsDir = (d) => platform.files?.setDownloadsDir?.(d);
  const c = new AppCore({ discordApiOrigin: init.discordApiOrigin }, platform);
  // What the network checks learned (the reference speed, the automatic pieces in flight) is kept by the
  // agent itself: in the browser the page keeps it, but the agent also runs with no window open.
  const netFile = join(init.dataDir, "net.json");
  const net = ((): { baseline?: unknown; tune?: { up?: number; down?: number } } => {
    try {
      return JSON.parse(readFileSync(netFile, "utf8"));
    } catch {
      return {};
    }
  })();
  c.setNetPrefs({ ...(net.baseline ? { baseline: net.baseline } : {}), ...(net.tune ? { tune: net.tune } : {}) });
  const keepNet = (patch: typeof net) => {
    Object.assign(net, patch);
    try {
      writeFileSync(netFile, JSON.stringify(net), { mode: 0o600 });
    } catch {
      /* next time */
    }
  };
  c.onEvent = (e) => {
    track(e);
    if (e.type === "net-baseline") keepNet({ baseline: e.data });
    else if (e.type === "net-tune") keepNet({ tune: e.data });
    broadcast(e);
  };
  core = c;
  // An account already on this computer: sign in and continue unfinished downloads without a window.
  const st = await c.status().catch(() => null);
  if (st?.hasAccount) {
    void c
      .open()
      .then(() => c.resumeDownloads())
      .catch((e) => console.error(`agent: open: ${String((e as Error)?.message ?? e)}`));
  }
  return c;
}

function serve(port: Port) {
  ports.add(port);
  port.on("message", async (e) => {
    const m = e.data as { id?: unknown; method?: unknown; args?: unknown } | null;
    if (!m || typeof m !== "object" || !Number.isSafeInteger(m.id)) return;
    const id = m.id as number;
    try {
      if (m.method === "ping") return port.postMessage({ id, ok: true, result: { ok: true, node: process.versions.node, sqlite: new DatabaseSync(":memory:").prepare("select sqlite_version() v").get()?.v } });
      // The window's init: the agent made the core already; a window configures nothing.
      if (m.method === "init") return port.postMessage({ id, ok: true, result: null });
      const why = checkCall(m.method, m.args);
      if (why) throw new Error(why);
      const c = await (ready ?? Promise.reject(new Error("agent not initialised")));
      // open(): the agent opens the account at start; a window asking again gets the same session.
      if (m.method === "open" && (await c.status()).signedIn) return port.postMessage({ id, ok: true, result: null });
      const fn = (c as unknown as Record<string, (...a: unknown[]) => unknown>)[m.method as string]!;
      const result = await encodeBlobs(await fn.apply(c, m.args as unknown[]));
      port.postMessage({ id, ok: true, result });
    } catch (err) {
      port.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
    }
  });
  port.on("close", () => ports.delete(port));
  port.start();
}

parent?.on("message", (e) => {
  const m = e.data as { type?: string; id?: number; ok?: boolean; data?: Uint8Array; error?: string };
  if (m?.type === "init" && !ready) ready = start(m as unknown as AgentInit);
  else if (m?.type === "port" && e.ports[0]) serve(e.ports[0]);
  else if (m?.type === "sealed" && typeof m.id === "number") {
    const w = sealWait.get(m.id);
    sealWait.delete(m.id);
    if (m.ok && m.data) w?.ok(new Uint8Array(m.data));
    else w?.err(new Error(m.error ?? "key store error"));
  } else if (m?.type === "downloads-dir" && typeof (m as { dir?: unknown }).dir === "string") {
    setDownloadsDir((m as { dir: string }).dir);
  } else if (m?.type === "pause") {
    // Tray: pause / resume every transfer. Requests wait at the network gate (as when offline) and
    // continue where they were; nothing is cancelled.
    void ready?.then((c) => c.setOnline(!(m as { on?: boolean }).on));
  } else if (m?.type === "quit") {
    core?.close();
    process.exit(0);
  }
});
