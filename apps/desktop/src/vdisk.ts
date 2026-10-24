// The disk in the system (Linux, FUSE): the agent's side. A Unix socket the ddn-fuse helper connects to;
// every answer comes from the AppCore (the tree from its index, bytes through readRange with a disk cache
// of decrypted fragments bounded per device, LRU). Read-only in this version.
//
// Protocol: request = u32 LE length + JSON; answer = u32 LE length + JSON + u32 LE length + bytes.
//   {op:"list", id}               -> {entries:[{id,name,kind,size,mtime}]}
//   {op:"stat", id}               -> {entry}
//   {op:"read", id, off, len}     -> {} + bytes
//   {op:"statfs"}                 -> {total, free}
// Errors: {err:"ENOENT"|"EIO"|"EAGAIN"}.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/** What the disk needs from the core (structural, so tests can give a fake). */
export interface VdiskCore {
  vdiskList(id: string): { id: string; name: string; kind: "file" | "folder"; size: number; mtime: number }[] | null;
  vdiskStat(id: string): { id: string; name: string; kind: "file" | "folder"; size: number; mtime: number } | null;
  vdiskRead(id: string, off: number, len: number, cache: Map<string, Uint8Array>): Promise<Uint8Array>;
}

/**
 * Decrypted fragments on disk, at most `limit` bytes (LRU by last use). Keys are "<versionId>:<index>";
 * files are named by their SHA-256 (the key holds no secret, but it need not be readable either).
 * A Map, so readVersionRange uses it as its fragment cache.
 */
export class FragDiskCache extends Map<string, Uint8Array> {
  private used = 0;
  private readonly meta = new Map<string, { size: number; at: number }>();
  /** Version IDs of files open in the system: their fragments stay. */
  readonly pinned = new Set<string>();
  constructor(
    readonly dir: string,
    public limit: number,
  ) {
    super();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // What an earlier run left: kept (it is the cache), counted, oldest first.
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".frag")) continue;
      try {
        const st = statSync(join(dir, f));
        this.meta.set(f.slice(0, -5), { size: st.size, at: st.mtimeMs });
        this.used += st.size;
      } catch {
        /* gone */
      }
    }
    this.trim();
  }
  private file(k: string) {
    return join(this.dir, createHash("sha256").update(k).digest("hex").slice(0, 40) + ".frag");
  }
  private keyName(k: string) {
    return createHash("sha256").update(k).digest("hex").slice(0, 40);
  }
  override get(k: string): Uint8Array | undefined {
    const n = this.keyName(k);
    const m = this.meta.get(n);
    if (!m) return undefined;
    try {
      const b = new Uint8Array(readFileSync(this.file(k)));
      m.at = Date.now();
      return b;
    } catch {
      this.meta.delete(n);
      this.used -= m.size;
      return undefined;
    }
  }
  override has(k: string): boolean {
    return this.meta.has(this.keyName(k));
  }
  override set(k: string, v: Uint8Array): this {
    const n = this.keyName(k);
    if (this.meta.has(n)) return this;
    // A fragment bigger than the whole limit is not kept (it is still returned to the reader).
    if (v.byteLength > this.limit) return this;
    try {
      writeFileSync(this.file(k), v, { mode: 0o600 });
    } catch {
      return this;
    }
    this.meta.set(n, { size: v.byteLength, at: Date.now() });
    this.used += v.byteLength;
    this.owner.set(n, k.split(":")[0]!);
    this.trim();
    return this;
  }
  private readonly owner = new Map<string, string>();
  /** Bytes in the cache now. */
  get bytes() {
    return this.used;
  }
  /** Drop the least recently used until under the limit (not the fragments of open files). */
  trim() {
    if (this.used <= this.limit) return;
    const order = [...this.meta].sort((a, b) => a[1].at - b[1].at);
    for (const [n, m] of order) {
      if (this.used <= this.limit) break;
      const v = this.owner.get(n);
      if (v && this.pinned.has(v)) continue;
      try {
        unlinkSync(join(this.dir, n + ".frag"));
      } catch {
        /* gone already */
      }
      this.meta.delete(n);
      this.owner.delete(n);
      this.used -= m.size;
    }
  }
  override clear() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta.clear();
    this.owner.clear();
    this.used = 0;
  }
}

/** Serve the helper's requests on `socketPath` (0600 in a 0700 directory). */
export function serveVdisk(core: VdiskCore, socketPath: string, cache: FragDiskCache): Server & { conns: Set<Socket> } {
  const dir = join(socketPath, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  const conns = new Set<Socket>();
  const srv = Object.assign(
    createServer((sock) => {
      conns.add(sock);
      sock.on("close", () => conns.delete(sock));
      connection(core, sock, cache);
    }),
    { conns },
  );
  srv.listen(socketPath);
  // listen() creates the socket with the umask: owner only.
  srv.on("listening", () => {
    try {
      spawnSync("chmod", ["600", socketPath]);
    } catch {
      /* best effort; the directory is 0700 anyway */
    }
  });
  return srv;
}

function connection(core: VdiskCore, sock: Socket, cache: FragDiskCache) {
  let buf = Buffer.alloc(0);
  let busy = Promise.resolve();
  const send = (j: unknown, data: Uint8Array = new Uint8Array(0)) => {
    const body = Buffer.from(JSON.stringify(j));
    const h1 = Buffer.alloc(4);
    h1.writeUInt32LE(body.length);
    const h2 = Buffer.alloc(4);
    h2.writeUInt32LE(data.byteLength);
    sock.write(Buffer.concat([h1, body, h2, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
  };
  const handle = async (q: { op?: string; id?: string; off?: number; len?: number }) => {
    try {
      if (q.op === "list") {
        const l = core.vdiskList(String(q.id));
        return l ? send({ entries: l }) : send({ err: "ENOENT" });
      }
      if (q.op === "stat") {
        const e = core.vdiskStat(String(q.id));
        return e ? send({ entry: e }) : send({ err: "ENOENT" });
      }
      if (q.op === "read") {
        if (!Number.isSafeInteger(q.off) || !Number.isSafeInteger(q.len) || q.len! < 0 || q.len! > 64 << 20) return send({ err: "EIO" });
        return send({}, await core.vdiskRead(String(q.id), q.off!, q.len!, cache));
      }
      if (q.op === "statfs") return send({ total: cache.limit, free: Math.max(0, cache.limit - cache.bytes) });
      send({ err: "EIO" });
    } catch (e) {
      send({ err: /not a file|no such|gone/i.test(String((e as Error)?.message)) ? "ENOENT" : "EIO" });
    }
  };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const q = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")) as Parameters<typeof handle>[0];
      buf = buf.subarray(4 + n);
      // One request at a time per connection (the helper waits for each answer).
      busy = busy.then(() => handle(q));
    }
  });
  sock.on("error", () => {});
}

/** PIDs of ddn-fuse processes of this user serving `mountpoint` (from /proc: no pgrep needed). */
export function helpersFor(mountpoint: string): number[] {
  const out: number[] = [];
  const uid = process.getuid?.();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (uid !== undefined && statSync(`/proc/${d}`).uid !== uid) continue;
      const argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
      if (argv[0]?.endsWith("ddn-fuse") && argv[1] === mountpoint) out.push(Number(d));
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** The mount: the helper process, cleaning a stale mount first (a killed helper leaves one). */
export class Vdisk {
  private child: ChildProcess | null = null;
  private srv: (Server & { conns: Set<Socket> }) | null = null;
  constructor(
    readonly opts: { helper: string; mountpoint: string; socket: string; cache: FragDiskCache; core: VdiskCore; log?: (m: string) => void; fusermount?: string; onState?: (s: string) => void },
  ) {}

  /** Can this computer mount it (FUSE device, fusermount3, the helper)? null = yes, else why not. */
  static unavailable(helper: string, fusermount = "fusermount3"): string | null {
    if (process.platform !== "linux") return "not linux";
    if (!existsSync("/dev/fuse")) return "no /dev/fuse";
    if (spawnSync(fusermount, ["-V"]).error) return "no fusermount3";
    if (!existsSync(helper)) return "no helper";
    return null;
  }

  /**
   * Clean what an earlier run left: a helper still running for this mount point (its agent died: it answers
   * EIO to everything) is stopped, and the mount is taken down lazily (a killed helper leaves "not
   * connected"; a file manager may hold the directory).
   */
  cleanStale() {
    const mp = this.opts.mountpoint;
    for (const pid of helpersFor(mp)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    spawnSync(this.opts.fusermount ?? "fusermount3", ["-u", "-z", "-q", mp]);
  }

  private stopping = false;
  private restarts = 0;

  private async remount(): Promise<void> {
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
    this.srv = null;
    await this.start();
  }

  async start(): Promise<void> {
    this.stopping = false;
    const mp = this.opts.mountpoint;
    this.cleanStale();
    mkdirSync(mp, { recursive: true });
    if (readdirSync(mp).length) throw new Error(`${mp} is not empty`);
    this.srv = serveVdisk(this.opts.core, this.opts.socket, this.opts.cache);
    await new Promise<void>((r) => this.srv!.once("listening", () => r()));
    this.child = spawn(this.opts.helper, [mp, this.opts.socket], { stdio: ["ignore", "ignore", "pipe"] });
    this.child.stderr?.on("data", (d) => this.opts.log?.(`vdisk: ${String(d).trim()}`));
    const me = this.child;
    me.on("exit", (code, sig) => {
      this.opts.log?.(`vdisk: helper exited ${code ?? sig}`);
      if (this.child !== me) return;
      this.child = null;
      // Killed or crashed while the disk should be there: clean up and mount again (a few tries).
      if (!this.stopping && this.restarts < 5) {
        this.restarts++;
        this.opts.onState?.("restarting");
        setTimeout(() => {
          if (this.stopping) return;
          void this.remount().then(
            () => this.opts.onState?.("mounted"),
            (e) => this.opts.onState?.(`error: ${String((e as Error)?.message ?? e)}`),
          );
        }, 500);
      } else if (!this.stopping) this.opts.onState?.(`error: helper exited ${code ?? sig}`);
    });
    // Mounted when the directory shows the root (the helper mounts in a few ms).
    for (let i = 0; i < 100; i++) {
      if (this.mounted()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the disk did not mount");
  }

  /** Tests: the agent "dies" (its connections to the helper close), the helper keeps running. */
  dropAgentForTest() {
    this.stopping = true;
    for (const c of this.srv?.conns ?? []) c.destroy();
    this.srv?.close();
    this.srv = null;
  }

  mounted(): boolean {
    try {
      return readFileSync("/proc/self/mounts", "utf8").split("\n").some((l) => l.split(" ")[1] === this.opts.mountpoint.replace(/ /g, "\\040") && l.includes("fuse"));
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    spawnSync(this.opts.fusermount ?? "fusermount3", ["-u", "-z", this.opts.mountpoint]);
    this.child?.kill();
    this.child = null;
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
    this.srv = null;
  }
}
