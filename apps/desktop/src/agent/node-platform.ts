// The desktop agent's platform for the application core (the same AppCore the browser runs in its worker):
// the tree in a node:sqlite file, upload journals and keys as files in the app's data folder, the transfer
// log as JSON Lines files. Keys are sealed by `sealer` (the main process wraps them with the OS key store;
// without one they are stored as files with owner-only permissions and Diagnostics says so).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { SqliteIndexStore } from "@ddv4/metadata-client/node";
import { exportDeviceKey, importDeviceKey, resumeKeys, type LaneFetch, type UploadJournal } from "@ddv4/metadata-client";
import type { CorePlatform, DiskFiles, KeyStore, PlatformResumeStore, TransferLogStore } from "../../../web-mo/src/platform.js";
import type { StoredAccount } from "../../../web-mo/src/keystore.js";

const POSIX = process.platform !== "win32";

let tmpSeq = 0;
/**
 * Write a file atomically (temp + rename) with owner-only permissions. Each write its own temp file: two
 * writes of the same file at once (a journal updated by two fragments landing together) must not share one
 * (on Windows the second then failed with ENOENT when the first renamed it away).
 */
export function writePrivate(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  if (POSIX) chmodSync(path, 0o600);
}

function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Wraps secrets before they reach the disk (OS key store in the main process), or stores them as they are. */
export interface Sealer {
  /** "os": encrypted with the OS key store; "file": plain file, owner-only permissions. */
  readonly kind: "os" | "file";
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}
export const plainSealer: Sealer = { kind: "file", seal: async (b) => b, open: async (b) => b };

/** What keys.json holds: the account record with the device key as PKCS#8 (sealed as a whole). */
type StoredJson = Omit<StoredAccount, "devicePrivateKey"> & { devicePkcs8: string };

/** keys.bin: "DDNK" + 1 byte how it is protected ("S": sealed by the OS key store, "P": plain) + body. */
const KEY_MAGIC = "DDNK";

/** The keys are on this computer but the system key store (keyring) is locked or missing now: code "keystore_locked". */
export function keysLocked(why: string): Error {
  return Object.assign(new Error(`${why} (unlock the keyring and try again, or use your rescue kit)`), { code: "keystore_locked" });
}

export function fileKeyStore(dir: string, sealer: Sealer, o: { serverUrl?: () => string | undefined } = {}): KeyStore {
  const file = join(dir, "keys.bin");
  const write = async (j: StoredJson) => {
    const body = new TextEncoder().encode(JSON.stringify(j));
    const sealed = sealer.kind === "os";
    const out = sealed ? await sealer.seal(body) : body;
    writePrivate(file, Buffer.concat([Buffer.from(KEY_MAGIC + (sealed ? "S" : "P")), Buffer.from(out)]));
  };
  return {
    async load() {
      if (!existsSync(file)) return undefined;
      const raw = readFileSync(file);
      if (raw.subarray(0, 4).toString() !== KEY_MAGIC) throw new Error("keys.bin: unknown format");
      const how = String.fromCharCode(raw[4]!);
      const body = new Uint8Array(raw.subarray(5));
      if (how === "S" && sealer.kind !== "os") throw keysLocked("the keys are protected by the system key store, which is not available now");
      // A locked keyring asks to unlock it; Cancel (or a wrong password) ends here.
      const plain = how === "S" ? await sealer.open(body).catch((e) => { throw keysLocked(`the system key store did not open the keys (${String((e as Error)?.message ?? e)})`); }) : body;
      const j = JSON.parse(new TextDecoder().decode(plain)) as StoredJson;
      // The system key store became available: protect the keys with it from now on.
      if (how === "P" && sealer.kind === "os") await write(j);
      const { devicePkcs8, ...rest } = j;
      // Refuses a stored pair whose halves do not match.
      await importDeviceKey({ pkcs8: devicePkcs8, publicKey: j.devicePublicKey });
      // The instance built into the app listens on a new port at every start: the account follows it.
      const url = o.serverUrl?.();
      // Extractable: saving the account again (rename, kit confirmed) exports it once more.
      return { ...rest, ...(url ? { serverUrl: url } : {}), devicePrivateKey: await privateOf(devicePkcs8) };
    },
    async save(a) {
      const { devicePrivateKey, ...rest } = a;
      const { pkcs8 } = await exportDeviceKey({ privateKey: devicePrivateKey, publicKey: a.devicePublicKey }).catch(() => {
        throw new Error("device key is not extractable (created outside the desktop agent)");
      });
      await write({ ...rest, devicePkcs8: pkcs8 });
    },
    async clear() {
      rmSync(file, { force: true });
    },
  };
}

/** The stored PKCS#8 as an extractable CryptoKey (saving it again must be able to export it). */
async function privateOf(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), { name: "Ed25519" }, true, ["sign"]);
}

/**
 * Upload journals of one account: one JSON file per key under resume/<account>/ (file name = SHA-256 of
 * the key, the key itself inside). Written atomically, so a crash never leaves half an entry.
 */
export class FileResumeStore implements PlatformResumeStore {
  private readonly dir: string;
  constructor(root: string, accountId: string) {
    this.dir = ensureDir(join(root, "resume", accountId.replace(/[^A-Za-z0-9_-]/g, "_")));
  }
  private path(key: string) {
    return join(this.dir, createHash("sha256").update(key).digest("hex") + ".json");
  }
  async get(key: string): Promise<unknown> {
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    return (JSON.parse(readFileSync(p, "utf8")) as { v: unknown }).v;
  }
  async put(key: string, value: unknown): Promise<void> {
    writePrivate(this.path(key), JSON.stringify({ k: key, v: value }));
  }
  async del(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }
  async entries(prefix: string): Promise<[string, unknown][]> {
    const out: [string, unknown][] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as { k: string; v: unknown };
        if (e.k.startsWith(prefix)) out.push([e.k, e.v]);
      } catch {
        /* a file being replaced right now */
      }
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  async delPrefix(prefix: string): Promise<void> {
    for (const [k] of await this.entries(prefix)) await this.del(k);
  }
  async uploads(): Promise<{ key: string; j: UploadJournal; have: number }[]> {
    const out: { key: string; j: UploadJournal; have: number }[] = [];
    for (const [k, v] of await this.entries("up:")) {
      const j = v as UploadJournal;
      if (j?.v !== 1) continue;
      const key = k.slice(3);
      out.push({ key, j, have: (await this.entries(resumeKeys(key).frags)).length });
    }
    return out;
  }
  async forget(key: string): Promise<void> {
    const r = resumeKeys(key);
    await this.del(r.head);
    await this.delPrefix(r.frags);
  }
}

const LOG_MAX_BYTES = 50 * 1024 * 1024;
const LOG_PART_BYTES = 8 * 1024 * 1024;

/** Transfer log as JSON Lines files (one per agent session and part; oldest parts dropped past 50 MB). */
export class FileTransferLog implements TransferLogStore {
  readonly where = "file";
  private readonly dir: string;
  private buf: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly session = new Date().toISOString().replace(/[:.]/g, "-");
  private part = 0;
  constructor(root: string) {
    this.dir = ensureDir(join(root, "transfer-logs"));
  }
  write = (line: string): void => {
    this.buf.push(line);
    this.timer ??= setInterval(() => void this.flush(), 1000);
  };
  private current() {
    return join(this.dir, `${this.session}-${String(this.part).padStart(3, "0")}.jsonl`);
  }
  async flush(): Promise<void> {
    if (!this.buf.length) return;
    const text = this.buf.join("");
    this.buf = [];
    let f = this.current();
    if (existsSync(f) && statSync(f).size > LOG_PART_BYTES) {
      this.part++;
      f = this.current();
    }
    appendFileSync(f, text, { mode: 0o600 });
    this.trim();
  }
  private files() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => ({ f: join(this.dir, f), size: statSync(join(this.dir, f)).size }));
  }
  private trim() {
    const fs = this.files();
    let total = fs.reduce((s, x) => s + x.size, 0);
    for (const x of fs) {
      if (total <= LOG_MAX_BYTES || x.f === this.current()) break;
      rmSync(x.f, { force: true });
      total -= x.size;
    }
  }
  async size(): Promise<number> {
    return this.files().reduce((s, x) => s + x.size, 0) + this.buf.reduce((s, l) => s + l.length, 0);
  }
  async text(): Promise<string> {
    await this.flush();
    return this.files()
      .map((x) => readFileSync(x.f, "utf8"))
      .join("");
  }
  async clear(): Promise<{ kept: number }> {
    await this.flush();
    for (const x of this.files()) rmSync(x.f, { force: true });
    return { kept: 0 };
  }
  async stop(): Promise<void> {
    await this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface NodePlatformOptions {
  /** The app's data folder (Electron: app.getPath("userData")). */
  dataDir: string;
  sealer?: Sealer;
  /** Requests to Discord (the agent's HTTP/2 pool, h2Fetch); default: the global fetch. */
  discordFetch?: typeof fetch;
  /** Extra download connections for the stuck-connection guard. */
  cdnLanes?: LaneFetch[];
  /** Default folder for downloads. */
  downloadsDir?: string;
  /** The instance built into the app: its address at this start (the stored account follows it). */
  serverUrl?: () => string | undefined;
}

/** Files on this computer for the core: sources read on demand, downloads written at offsets. */
export function nodeDiskFiles(dir: string): DiskFiles & { setDownloadsDir(d: string): void } {
  let downloadsDir = dir;
  return {
    setDownloadsDir: (d) => void (downloadsDir = d),
    downloadsDir: () => downloadsDir,
    async isDir(p) {
      return (await stat(p)).isDirectory();
    },
    async stat(p) {
      const st = await stat(p);
      if (!st.isFile()) throw new Error("not a file");
      return { size: st.size };
    },
    async walk(dir) {
      const out: { path: string; rel: string[]; size: number }[] = [];
      const go = async (d: string, rel: string[]) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          // Symbolic links are not followed (a link to "/" must not upload the whole disk).
          if (e.isDirectory()) await go(p, [...rel, e.name]);
          else if (e.isFile()) out.push({ path: p, rel: [...rel, e.name], size: (await stat(p)).size });
        }
      };
      await go(dir, []);
      return out;
    },
    async openSource(path) {
      const fh = await open(path, "r");
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        throw new Error("not a file");
      }
      return {
        size: st.size,
        name: basename(path),
        mtimeMs: st.mtimeMs,
        async read(offset, length) {
          const len = Math.max(0, Math.min(length, st.size - offset));
          const buf = new Uint8Array(len);
          let got = 0;
          while (got < len) {
            const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
            if (!bytesRead) throw new Error("file shorter than when opened (changed on disk?)");
            got += bytesRead;
          }
          return buf;
        },
        close: () => fh.close(),
      };
    },
    async openTarget(dir, name, partKey) {
      await mkdir(dir, { recursive: true });
      const safe = safeFileName(name);
      // One partial file per download (the key: version + folder), so two downloads of different files with
      // the same name never share one.
      const tag = createHash("sha256").update(partKey).digest("hex").slice(0, 8);
      const partPath = join(dir, `${safe}.${tag}.ddnpart`);
      const fh = await open(partPath, existsSync(partPath) ? "r+" : "w+", 0o600);
      const size = (await fh.stat()).size;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await fh.close();
      };
      return {
        partPath,
        size,
        truncate: (len) => fh.truncate(len),
        async writeAt(offset, data) {
          let put = 0;
          while (put < data.byteLength) put += (await fh.write(data, put, data.byteLength - put, offset + put)).bytesWritten;
        },
        async finish() {
          await fh.sync();
          await close();
          const finalPath = freeName(dir, safe);
          await rename(partPath, finalPath);
          return { finalPath };
        },
        close,
      };
    },
  };
}

/** A name every supported system accepts (Windows forbids <>:"/\|?* and trailing dots/spaces). */
export function safeFileName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s || "file";
}

/** `name`, or `name (1)`, `name (2)`, … when taken. */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

export function nodePlatform(o: NodePlatformOptions): CorePlatform & { dataDir: string; sealer: Sealer } {
  const root = ensureDir(o.dataDir);
  const sealer = o.sealer ?? plainSealer;
  let tlog: FileTransferLog | null = null;
  return {
    kind: "desktop",
    dataDir: root,
    sealer,
    discordFetch: o.discordFetch,
    cdnLanes: o.cdnLanes,
    files: nodeDiskFiles(o.downloadsDir ?? join(homedir(), "Downloads")),
    keys: fileKeyStore(root, sealer, { serverUrl: o.serverUrl }),
    keyProtection: sealer.kind,
    extractableDeviceKey: true,
    // The agent is the only process that opens this account (the app holds a single-instance lock).
    leadership: (_id, onChange) => {
      onChange(true);
      return { ready: Promise.resolve(), release: () => {} };
    },
    async openIndex(accountId) {
      const dir = ensureDir(join(root, "index"));
      return { store: new SqliteIndexStore(join(dir, `${accountId.replace(/[^A-Za-z0-9_-]/g, "_")}.db`)), persistent: true };
    },
    resume: (accountId) => new FileResumeStore(root, accountId),
    transferLog: () => (tlog ??= new FileTransferLog(root)),
    gzip: async (text) => ({ data: new Blob([gzipSync(text)], { type: "application/gzip" }), gz: true }),
    homeOrigin: () => null,
  };
}
