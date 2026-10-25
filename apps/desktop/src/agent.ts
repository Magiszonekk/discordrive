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
//   { type: "range", id, nodeId, start, end }                                  bytes of a file (player, previews)
//   { type: "quit" }
// Messages to the main process:
//   { type: "seal" | "unseal", id, data }    the OS key store lives in the main process (safeStorage)
//   { type: "status", busy, up, down }       for the tray (what is running)
//   { type: "notify", kind, name, bytes }    a large transfer finished
//   { type: "range-result", id, ok, data, size, start, end | error }
import { FragDiskCache, Vdisk } from "./vdisk.js";
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
  /** Linux: the disk in the system (FUSE helper, mount point, the cache of pieces). */
  vdisk?: VdiskConfig;
}
export interface VdiskConfig {
  on: boolean;
  helper: string;
  mountpoint: string;
  socket: string;
  cacheDir: string;
  cacheBytes: number;
}

// ── the disk in the system ──
let disk: Vdisk | null = null;
let diskCache: FragDiskCache | null = null;
let diskBusy: Promise<void> = Promise.resolve();
function setVdisk(cfg: VdiskConfig | undefined) {
  diskBusy = diskBusy.then(async () => {
    if (!cfg) return;
    const c = await (ready ?? Promise.reject(new Error("agent not initialised"))).catch(() => null);
    if (!c) return;
    if (diskCache) diskCache.limit = cfg.cacheBytes;
    if (diskCache) diskCache.trim();
    if (!cfg.on) {
      if (disk) await disk.stop().catch(() => {});
      disk = null;
      // A mount left by an earlier run that was killed.
      new Vdisk({ helper: cfg.helper, mountpoint: cfg.mountpoint, socket: cfg.socket, cache: null as never, core: c as never }).cleanStale();
      return state("off");
    }
    if (disk && disk.mounted()) return state("mounted");
    const why = Vdisk.unavailable(cfg.helper);
    if (why) return state(`unavailable: ${why}`);
    // The account must be open (the tree from its index).
    for (let i = 0; i < 600 && !(await c.status()).signedIn; i++) await new Promise((r) => setTimeout(r, 500));
    diskCache ??= new FragDiskCache(cfg.cacheDir, cfg.cacheBytes);
    disk = new Vdisk({ helper: cfg.helper, mountpoint: cfg.mountpoint, socket: cfg.socket, cache: diskCache, core: c as never, log: (m) => console.error(m), onState: state });
    try {
      await disk.start();
      state("mounted");
    } catch (e) {
      state(`error: ${String((e as Error)?.message ?? e)}`);
    }
  });
}
function state(s: string) {
  parent?.postMessage({ type: "vdisk-state", state: s });
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
    // A key store that never answers (a keyring dialog left open, a stuck D-Bus): an error after 2 minutes,
    // so the window says why instead of waiting for ever.
    const t = setTimeout(() => {
      sealWait.delete(id);
      err(new Error("the system key store did not answer"));
    }, 120_000);
    sealWait.set(id, { ok: (b) => (clearTimeout(t), ok(b)), err: (e) => (clearTimeout(t), err(e)) });
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

/** Calls that carry a progress token (its position in the arguments) and run a transfer. */
const TRANSFER_CALLS: Map<string, { dir: "up" | "down"; tokenAt: number }> = new Map<string, { dir: "up" | "down"; tokenAt: number }>([
  ["uploadPath", { dir: "up", tokenAt: 3 }],
  ["uploadPaths", { dir: "up", tokenAt: 2 }],
  ["upload", { dir: "up", tokenAt: 3 }],
  ["downloadToDisk", { dir: "down", tokenAt: 2 }],
  ["download", { dir: "down", tokenAt: 1 }],
]);
function settle(method: string, args: unknown[]) {
  const t = TRANSFER_CALLS.get(method)!;
  const token = args[t.tokenAt];
  const m = t.dir === "up" ? running.up : running.down;
  if (typeof token !== "string" || !token) return;
  // uploadPaths tags each file `<token>:<n>`.
  for (const k of [...m.keys()]) if (k === token || k.startsWith(`${token}:`)) m.delete(k);
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
    // The tree changed (a sync, this device's own change): the file manager sees it without a restart.
    if (e.type === "changed") disk?.invalidate("all");
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
      let result: unknown;
      try {
        result = await encodeBlobs(await fn.apply(c, m.args as unknown[]));
      } finally {
        // A transfer is over when its call returns (or fails), whatever its last progress event said: the
        // tray and "Quit" must not see it running after that.
        if (TRANSFER_CALLS.has(m.method as string)) settle(m.method as string, m.args as unknown[]);
      }
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
  if (m?.type === "init" && !ready) {
    ready = start(m as unknown as AgentInit);
    setVdisk((m as unknown as AgentInit).vdisk);
  } else if (m?.type === "vdisk") setVdisk(m as unknown as VdiskConfig);
  else if (m?.type === "port" && e.ports[0]) serve(e.ports[0]);
  else if (m?.type === "sealed" && typeof m.id === "number") {
    const w = sealWait.get(m.id);
    sealWait.delete(m.id);
    if (m.ok && m.data) w?.ok(new Uint8Array(m.data));
    else w?.err(new Error(m.error ?? "key store error"));
  } else if (m?.type === "range" && typeof m.id === "number") {
    const q = m as unknown as { id: number; nodeId: unknown; start: unknown; end: unknown };
    void (async () => {
      try {
        if (typeof q.nodeId !== "string" || !Number.isSafeInteger(q.start) || !Number.isSafeInteger(q.end)) throw new Error("bad range");
        const c = await (ready ?? Promise.reject(new Error("agent not initialised")));
        const r = await c.readRange(q.nodeId, q.start as number, q.end as number);
        parent.postMessage({ type: "range-result", id: q.id, ok: true, data: r.data, size: r.size, start: r.start, end: r.end, name: r.name });
      } catch (err) {
        parent.postMessage({ type: "range-result", id: q.id, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  } else if (m?.type === "downloads-dir" && typeof (m as { dir?: unknown }).dir === "string") {
    setDownloadsDir((m as { dir: string }).dir);
  } else if (m?.type === "pause") {
    // Tray: pause / resume every transfer. Requests wait at the network gate (as when offline) and
    // continue where they were; nothing is cancelled.
    void ready?.then((c) => c.setOnline(!(m as { on?: boolean }).on));
  } else if (m?.type === "quit") {
    // The disk first: a mount left behind would show "not connected" in the file manager.
    void (disk ? disk.stop().catch(() => {}) : Promise.resolve()).then(() => {
      core?.close();
      process.exit(0);
    });
  }
});
