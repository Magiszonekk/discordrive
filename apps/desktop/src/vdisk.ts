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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Thumbnails, type ThumbCore } from "./vdisk-thumbs.js";

/** What the disk needs from the core (structural, so tests can give a fake). */
export interface VdiskCore {
  /** The stored picture of a file (thumbnails for the file manager), null when it has none. */
  vdiskPreview?(id: string, kind: "t" | "p"): Promise<{ data: Uint8Array; mime: string } | null>;
  /** The path of a folder in the mount ("" for the root), for the thumbnails' URIs. */
  vdiskPath?(id: string): string | null;
  vdiskList(id: string): { id: string; name: string; kind: "file" | "folder"; size: number; mtime: number }[] | null;
  vdiskStat(id: string): { id: string; name: string; kind: "file" | "folder"; size: number; mtime: number } | null;
  vdiskRead(id: string, off: number, len: number, cache: Map<string, Uint8Array>): Promise<Uint8Array>;
  /** Writing (when the disk is writable): a closed file's local copy uploaded, folders, renames, the trash. */
  vdiskUpload?(path: string, dirId: string, name: string): Promise<{ id: string }>;
  vdiskMkdir?(dirId: string, name: string): Promise<{ id: string }>;
  vdiskRename?(dirId: string, name: string, toDirId: string, toName: string): Promise<void>;
  vdiskRemove?(dirId: string, name: string, folder: boolean): Promise<void>;
  /** Throws (EINVAL / EISDIR / ENOENT …) when `name` cannot be written into `dirId`. */
  vdiskCheckName?(dirId: string, name: string): void;
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
/**
 * Files written into the disk, waiting for their upload (one at a time, in the background): each a local
 * copy `q-<n>` in the outbox and its target `q-<n>.json`, so the queue survives a restart of the app. Until
 * uploaded a file shows in its folder from the copy (id `out:<n>`), the file manager can open it again.
 */
export class Outbox {
  private items = new Map<string, { n: string; dir: string; name: string; size: number; mtime: number; trashed?: boolean }>();
  private seq = Date.now();
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  /** After each upload (ok or not): the folder, the name, the pending id, an error. */
  onDone: (dir: string, name: string, id: string, err: string | null) => void = () => {};
  constructor(
    readonly dir: string,
    private readonly core: VdiskCore,
    private readonly log: (m: string) => void = () => {},
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir)) {
      const m = /^q-(\d+)\.json$/.exec(f);
      if (!m) {
        // A writer's copy left by a crash (w-*), not queued: nothing to keep.
        if (/^w-/.test(f)) rmSync(join(dir, f), { force: true });
        continue;
      }
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { dir: string; name: string; mtime: number };
        const st = statSync(join(dir, `q-${m[1]}`));
        this.items.set(m[1]!, { n: m[1]!, dir: j.dir, name: j.name, size: st.size, mtime: j.mtime, trashed: false });
      } catch {
        rmSync(join(dir, f), { force: true });
      }
    }
  }
  /** Take a closed file's copy (moved into the queue) for `dir`/`name`; the id it shows under until uploaded. */
  add(path: string, dir: string, name: string): string {
    const n = String(++this.seq);
    const st = statSync(path);
    renameSync(path, join(this.dir, `q-${n}`));
    writeFileSync(join(this.dir, `q-${n}.json`), JSON.stringify({ dir, name, mtime: st.mtimeMs }), { mode: 0o600 });
    // A newer copy of the same name replaces one not started yet (an editor saving often).
    for (const [k, it] of this.items) if (it.dir === dir && it.name === name && k !== this.current) this.drop(k);
    this.items.set(n, { n, dir, name, size: st.size, mtime: Date.now() });
    this.kick();
    return `out:${n}`;
  }
  private current: string | null = null;
  private drop(k: string) {
    this.items.delete(k);
    rmSync(join(this.dir, `q-${k}`), { force: true });
    rmSync(join(this.dir, `q-${k}.json`), { force: true });
  }
  /** What a folder shows from the queue (the newest copy of each name). */
  entries(dir: string): { id: string; name: string; kind: "file"; size: number; mtime: number }[] {
    const by = new Map<string, { id: string; name: string; kind: "file"; size: number; mtime: number }>();
    for (const it of this.items.values()) if (it.dir === dir && !it.trashed) by.set(it.name, { id: `out:${it.n}`, name: it.name, kind: "file", size: it.size, mtime: it.mtime });
    return [...by.values()];
  }
  pathOf(id: string): string | null {
    const k = /^out:(\d+)$/.exec(id)?.[1];
    return k && this.items.has(k) ? join(this.dir, `q-${k}`) : null;
  }
  /** A queued file renamed / moved / removed on the disk before its upload. */
  renamePending(dir: string, name: string, toDir: string, toName: string): boolean {
    let hit = false;
    for (const [k, it] of this.items)
      if (it.dir === dir && it.name === name && !it.trashed) {
        it.dir = toDir;
        it.name = toName;
        writeFileSync(join(this.dir, `q-${k}.json`), JSON.stringify({ dir: toDir, name: toName, mtime: it.mtime }), { mode: 0o600 });
        hit = true;
      }
    return hit;
  }
  removePending(dir: string, name: string): boolean {
    let hit = false;
    for (const [k, it] of this.items)
      if (it.dir === dir && it.name === name && !it.trashed) {
        hit = true;
        // The one uploading now goes to the trash once in the account; the others are just dropped.
        if (k === this.current) it.trashed = true;
        else this.drop(k);
      }
    return hit;
  }
  /** Resolves when the queue is empty (tests; quitting). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
  get size() {
    return this.items.size;
  }
  kick() {
    this.wake?.();
    if (this.running) return;
    this.running = this.loop().finally(() => (this.running = null));
  }
  private async loop() {
    let delay = 2000;
    for (;;) {
      const first = [...this.items.values()].sort((a, b) => Number(a.n) - Number(b.n))[0];
      if (!first) return;
      const next = { ...first };
      this.current = next.n;
      const path = join(this.dir, `q-${next.n}`);
      try {
        const at = { dir: next.dir, name: next.name };
        await this.core.vdiskUpload!(path, at.dir, at.name);
        const it = this.items.get(next.n);
        this.drop(next.n);
        // Renamed, moved or removed on the disk while it was uploading: the same in the account now.
        if (it?.trashed) await this.core.vdiskRemove?.(at.dir, at.name, false).catch(() => {});
        else if (it && (it.dir !== at.dir || it.name !== at.name)) await this.core.vdiskRename?.(at.dir, at.name, it.dir, it.name).catch((e) => this.log(`vdisk: rename after upload: ${e}`));
        this.onDone(it?.dir ?? at.dir, it?.name ?? at.name, `out:${next.n}`, null);
        delay = 2000;
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        this.log(`vdisk: upload of ${next.name} failed: ${m}`);
        this.onDone(next.dir, next.name, `out:${next.n}`, m);
        // A name or folder the account refuses: never uploadable, dropped (the error is in the log).
        if (/^(EINVAL|EISDIR|ENOENT)\b/.test(m)) this.drop(next.n);
        else {
          // No channel, no network: again later (the copy waits in the queue).
          await new Promise<void>((r) => {
            const t = setTimeout(r, delay);
            this.wake = () => (clearTimeout(t), r());
          });
          this.wake = null;
          delay = Math.min(delay * 2, 5 * 60_000);
        }
      } finally {
        this.current = null;
      }
    }
  }
}

export function serveVdisk(core: VdiskCore, socketPath: string, cache: FragDiskCache, hooks: Hooks = {}): Server & { conns: Set<Socket>; watchers: Set<Socket> } {
  const dir = join(socketPath, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  const conns = new Set<Socket>();
  const watchers = new Set<Socket>();
  const srv = Object.assign(
    createServer((sock) => {
      conns.add(sock);
      sock.on("close", () => (conns.delete(sock), watchers.delete(sock)));
      connection(core, sock, cache, { ...hooks, watch: () => watchers.add(sock) });
    }),
    { conns, watchers },
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

interface Hooks {
  /** A folder was listed (the file manager opened it). */
  listed?: (id: string, entries: ReturnType<VdiskCore["vdiskList"]> & object) => Promise<void> | void;
  /** The writable disk's queue of uploads (an upload's path must be inside its directory). */
  outbox?: Outbox;
  watch?: () => void;
}

function connection(core: VdiskCore, sock: Socket, cache: FragDiskCache, hooks: Hooks) {
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
  const handle = async (q: { op?: string; id?: string; off?: number; len?: number; dir?: string; name?: string; toDir?: string; toName?: string; path?: string; folder?: boolean }) => {
    try {
      // The helper's second connection: invalidations go out on it, nothing is answered.
      if (q.op === "watch") return hooks.watch?.();
      if (q.op === "list") {
        let l = core.vdiskList(String(q.id));
        // Files still in the upload queue show in their folder (over an older version of the same name).
        const ob = l && hooks.outbox?.entries(String(q.id));
        if (l && ob?.length) l = [...l.filter((e) => !ob.some((o) => o.name === e.name)), ...ob];
        // The folder's thumbnails first (up to 2 s): the file manager asks for them right after the listing,
        // and finds them ready instead of starting its own thumbnailers.
        if (l) await Promise.race([hooks.listed?.(String(q.id), l), new Promise((r) => setTimeout(r, 2000))]);
        return l ? send({ entries: l }) : send({ err: "ENOENT" });
      }
      if (q.op === "stat") {
        if (String(q.id).startsWith("out:")) {
          const p = hooks.outbox?.pathOf(String(q.id));
          if (!p) return send({ err: "ENOENT" });
          const st = statSync(p);
          return send({ entry: { id: q.id, name: "", kind: "file", size: st.size, mtime: st.mtimeMs } });
        }
        const e = core.vdiskStat(String(q.id));
        return e ? send({ entry: e }) : send({ err: "ENOENT" });
      }
      if (q.op === "read") {
        if (!Number.isSafeInteger(q.off) || !Number.isSafeInteger(q.len) || q.len! < 0 || q.len! > 64 << 20) return send({ err: "EIO" });
        if (String(q.id).startsWith("out:")) {
          const p = hooks.outbox?.pathOf(String(q.id));
          if (!p) return send({ err: "ENOENT" });
          const fh = await openFile(p, "r");
          try {
            const b = Buffer.alloc(q.len!);
            const { bytesRead } = await fh.read(b, 0, q.len!, q.off!);
            return send({}, b.subarray(0, bytesRead));
          } finally {
            await fh.close();
          }
        }
        return send({}, await core.vdiskRead(String(q.id), q.off!, q.len!, cache));
      }
      if (q.op === "statfs") return send({ total: cache.limit, free: Math.max(0, cache.limit - cache.bytes) });
      if (q.op === "upload" && core.vdiskUpload && typeof q.path === "string" && hooks.outbox && q.path.startsWith(hooks.outbox.dir + "/") && !q.path.includes("/../")) {
        const name = String(q.name);
        // The name checked now (the close fails at once), the upload queued (cp does not wait for Discord).
        core.vdiskCheckName?.(String(q.dir), name);
        return send({ id: hooks.outbox.add(q.path, String(q.dir), name) });
      }
      if (q.op === "rename" && hooks.outbox?.renamePending(String(q.dir), String(q.name), String(q.toDir), String(q.toName))) {
        core.vdiskCheckName?.(String(q.toDir), String(q.toName));
        // Also in the account when an older version of it is there.
        if (!core.vdiskList(String(q.dir))?.some((e) => e.name === q.name)) return send({});
      }
      if (q.op === "remove" && !q.folder && hooks.outbox?.removePending(String(q.dir), String(q.name))) {
        if (!core.vdiskList(String(q.dir))?.some((e) => e.name === q.name)) return send({});
      }
      if (q.op === "mkdir" && core.vdiskMkdir) return send(await core.vdiskMkdir(String(q.dir), String(q.name)));
      if (q.op === "rename" && core.vdiskRename) return (await core.vdiskRename(String(q.dir), String(q.name), String(q.toDir), String(q.toName)), send({}));
      if (q.op === "remove" && core.vdiskRemove) return (await core.vdiskRemove(String(q.dir), String(q.name), q.folder === true), send({}));
      send({ err: "EIO" });
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      const code = /^(ENOENT|EEXIST|EINVAL|EISDIR|ENOTDIR|ENOTEMPTY|ENOSPC|EACCES)\b/.exec(m)?.[1];
      send({ err: code ?? (/not a file|no such|gone/i.test(m) ? "ENOENT" : /need_channel|no channel/i.test(m) ? "ENOSPC" : "EIO") });
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

let systemdUserOk: boolean | null = null;
/** The user's service manager answers (systemd-run --user can start units). Checked once. */
export function systemdUser(): boolean {
  if (systemdUserOk === null) {
    const r = spawnSync("systemd-run", ["--user", "--quiet", "--collect", "--wait", "true"], { timeout: 10_000 });
    systemdUserOk = !r.error && r.status === 0;
  }
  return systemdUserOk;
}

/** This process has no_new_privs (setuid programs it runs get no privileges). */
export function noNewPrivs(): boolean {
  try {
    return /^NoNewPrivs:\s*1$/m.test(readFileSync("/proc/self/status", "utf8"));
  } catch {
    return false;
  }
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
  private srv: (Server & { conns: Set<Socket>; watchers: Set<Socket> }) | null = null;
  /** Thumbnails for the file manager (null without a helper that converts pictures, e.g. in tests). */
  thumbs: Thumbnails | null = null;
  /** Files written into the disk, until uploaded (writable disk only). */
  outbox: Outbox | null = null;
  /** What each folder listed (for the names an invalidation reports). */
  private readonly listedNow = new Map<string, { id: string; name: string }[]>();

  /**
   * Drop what the kernel cached (after a sync: changes from other devices show in the file manager). The
   * folders listed so far are compared with what they hold now: their added and removed names go along,
   * so the kernel tells inotify watchers and an open file manager window refreshes.
   */
  invalidate(ids: string[] | "all") {
    const names: { dir: string; added: string[]; removed: { id: string; name: string }[] }[] = [];
    for (const [dir, before] of this.listedNow) {
      const acc = this.opts.core.vdiskList(dir) ?? [];
      const ob = this.outbox?.entries(dir) ?? [];
      const now = [...acc.filter((e) => !ob.some((o) => o.name === e.name)), ...ob];
      const was = new Map(before.map((e) => [e.name, e.id]));
      const is = new Map(now.map((e) => [e.name, e.id]));
      const added = [...is.keys()].filter((n) => was.get(n) !== is.get(n));
      // Gone names only (a name whose node changed, a queued copy now uploaded, is just looked up again).
      const removed = [...was].filter(([n]) => !is.has(n)).map(([name, id]) => ({ id, name }));
      if (added.length || removed.length) names.push({ dir, added, removed });
      this.listedNow.set(dir, now.map((e) => ({ id: e.id, name: e.name })));
    }
    const body = Buffer.from(JSON.stringify({ inval: ids, names }));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    for (const w of this.srv?.watchers ?? []) w.write(Buffer.concat([h, body]));
  }
  constructor(
    readonly opts: {
      helper: string;
      mountpoint: string;
      socket: string;
      cache: FragDiskCache;
      core: VdiskCore;
      log?: (m: string) => void;
      fusermount?: string;
      onState?: (s: string) => void;
      /** Writable: local copies of written files go here until uploaded (null / absent: read-only). */
      outbox?: string;
      /** Where the freedesktop thumbnail cache is (default ~/.cache/thumbnails). */
      thumbnailDir?: string;
      noThumbnails?: boolean;
    },
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
    this.unmount();
  }

  /**
   * fusermount3 -u -z on the mount point. With no_new_privs the setuid fusermount3 gets no privileges here:
   * then it runs from the user's service manager, as the helper does.
   */
  private unmount() {
    const fm = this.opts.fusermount ?? "fusermount3";
    const args = ["-u", "-z", "-q", this.opts.mountpoint];
    if (noNewPrivs() && systemdUser()) spawnSync("systemd-run", ["--user", "--quiet", "--collect", "--wait", fm, ...args]);
    else spawnSync(fm, args);
  }

  /** Mounted and served: in the mount table and a helper alive for it (a killed one leaves a stale entry). */
  serving(): boolean {
    return this.mounted() && helpersFor(this.opts.mountpoint).length > 0;
  }

  private helperGone(code: number | null, sig: string | null) {
    this.opts.log?.(`vdisk: helper exited ${code ?? sig}`);
    if (this.stopping) return;
    // A mount the helper cannot make will not work the next time either: say why, do not loop.
    if (code === 4) return this.opts.onState?.(`error: ${noNewPrivs() && !systemdUser() ? "restart the app to turn on the disk" : "the system refused the mount (fusermount3)"}`);
    // Killed or crashed while the disk should be there: clean up and mount again (a few tries).
    if (this.restarts >= 5) return this.opts.onState?.(`error: the disk stopped (helper exited ${code ?? sig})`);
    this.restarts++;
    this.opts.onState?.("restarting");
    setTimeout(() => {
      if (this.stopping) return;
      void this.remount().then(
        () => this.opts.onState?.("mounted"),
        (e) => this.opts.onState?.(`error: ${String((e as Error)?.message ?? e)}`),
      );
    }, 500);
  }

  private stopping = false;
  private viaSystemd = false;
  private restarts = 0;

  private async remount(): Promise<void> {
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
    this.srv = null;
    await this.start();
  }

  async start(): Promise<void> {
    this.stopping = false;
    const mp = this.opts.mountpoint;
    const nnp = noNewPrivs();
    // no_new_privs without the user's service manager: no way to mount from this process.
    if (nnp && !systemdUser()) throw new Error("restart the app to turn on the disk");
    this.cleanStale();
    for (let i = 0; i < 20 && this.mounted(); i++) await new Promise((r) => setTimeout(r, 50));
    try {
      mkdirSync(mp, { recursive: true });
      if (readdirSync(mp).length) throw new Error(`${mp} is not empty`);
    } catch (e) {
      // A mount left behind that could not be taken down: say so in words.
      if ((e as NodeJS.ErrnoException).code === "ENOTCONN") throw new Error(`${mp} is still mounted by an earlier run: run "fusermount3 -u -z ${mp}" or log out and in`);
      throw e;
    }
    const core = this.opts.core;
    if (core.vdiskPreview && !this.opts.noThumbnails)
      this.thumbs ??= new Thumbnails({ helper: this.opts.helper, mountpoint: mp, core: core as ThumbCore, cacheDir: this.opts.thumbnailDir });
    if (this.opts.outbox && !this.outbox) {
      this.outbox = new Outbox(this.opts.outbox, core, this.opts.log);
      // Uploaded: the folder shows the account's file instead of the queued copy.
      this.outbox.onDone = (dir) => this.invalidate([dir]);
      this.outbox.kick();
    }
    this.srv = serveVdisk(core, this.opts.socket, this.opts.cache, {
      outbox: this.outbox ?? undefined,
      listed: (id, entries) => {
        this.listedNow.set(id, entries.map((e) => ({ id: e.id, name: e.name })));
        const dir = core.vdiskPath?.(id);
        if (this.thumbs && dir !== null && dir !== undefined) return this.thumbs.folder(entries.map((e) => ({ id: e.id, kind: e.kind, mtime: e.mtime, path: join(dir, e.name) })));
      },
    });
    await new Promise<void>((r) => this.srv!.once("listening", () => r()));
    // A process with no_new_privs (Electron after app.relaunch, some sandboxes) cannot run the setuid
    // fusermount3 its helper mounts with. Then the helper starts from the user's service manager
    // (systemd-run --user: a fresh process tree without the flag); the helper exits when this agent goes.
    const viaSystemd = nnp;
    const env = this.opts.outbox ? { ...process.env, DDN_FUSE_OUTBOX: this.opts.outbox } : process.env;
    this.child = viaSystemd
      ? spawn("systemd-run", ["--user", "--quiet", "--collect", "--pipe", "--wait", `--unit=discordrive-disk-${process.pid}-${Date.now()}`, ...(this.opts.outbox ? [`--setenv=DDN_FUSE_OUTBOX=${this.opts.outbox}`] : []), this.opts.helper, mp, this.opts.socket], { stdio: ["ignore", "ignore", "pipe"] })
      : spawn(this.opts.helper, [mp, this.opts.socket], { stdio: ["ignore", "ignore", "pipe"], env });
    this.viaSystemd = viaSystemd;
    this.child.stderr?.on("data", (d) => this.opts.log?.(`vdisk: ${String(d).trim()}`));
    const me = this.child;
    me.on("exit", (code, sig) => {
      if (this.child !== me) return;
      this.child = null;
      this.helperGone(code, sig);
    });
    // Mounted when the helper serves it (the helper mounts in a few ms; through systemd-run a bit later).
    for (let i = 0; i < 100; i++) {
      if (this.serving()) {
        this.watch();
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the disk did not mount");
  }

  /**
   * While mounted: a helper that is gone (killed: its systemd unit may not report it to us the way a child
   * does) is noticed within a second and the disk is mounted again, the same as a child's exit.
   */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => {
      if (this.stopping || this.child === null) return;
      if (helpersFor(this.opts.mountpoint).length === 0) {
        const c = this.child;
        this.child = null;
        c.removeAllListeners("exit");
        try {
          c.kill();
        } catch {
          /* gone */
        }
        this.helperGone(null, "gone");
      }
    }, 1000);
    this.watchTimer.unref?.();
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
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    // A helper started through systemd-run is not our child: it exits on the unmount (and on its socket).
    for (const pid of this.viaSystemd ? helpersFor(this.opts.mountpoint) : []) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    this.unmount();
    this.child?.kill();
    this.child = null;
    // The helper's own way out (it unmounts when its agent's connections close): needed where this
    // process cannot run fusermount3 itself (no_new_privs).
    for (const c of this.srv?.conns ?? []) c.destroy();
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
    this.srv = null;
    for (let i = 0; i < 40 && this.mounted(); i++) await new Promise((r) => setTimeout(r, 50));
  }
}
