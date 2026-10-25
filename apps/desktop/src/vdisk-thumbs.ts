// Thumbnails of the disk's files for the file manager, without downloading the files: the encrypted
// previews stored with them (decrypted in the agent) written into the freedesktop thumbnail cache, the
// way GNOME / KDE look them up (Thumbnail Managing Standard 0.9):
//   ~/.cache/thumbnails/{normal,large}/<md5(uri)>.png    PNG with tEXt Thumb::URI and Thumb::MTime
//   ~/.cache/thumbnails/fail/discordrive/<md5(uri)>.png   "no thumbnail" (no preview stored): the file
//                                                         manager does not run its own thumbnailer on it
// The URI is file:// + the path in the mount, percent-encoded; MTime is the mtime the disk reports (seconds).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export interface ThumbCore {
  /** The stored picture of a file ('t' thumbnail, 'p' preview), null when it has none. */
  vdiskPreview(id: string, kind: "t" | "p"): Promise<{ data: Uint8Array; mime: string } | null>;
}

/** file:// URI of a path as GLib builds it (each segment percent-encoded except unreserved and '/'). */
export function fileUri(path: string): string {
  return (
    "file://" +
    path
      .split("/")
      .map((seg) => [...new TextEncoder().encode(seg)].map((b) => (/[A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(String.fromCharCode(b)) && b < 0x80 ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0"))).join(""))
      .join("/")
  );
}

const crc = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = t[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

/** A PNG with tEXt chunks added right after IHDR (the spec's keys). */
export function withText(png: Buffer, text: Record<string, string>): Buffer {
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  const extra = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "latin1")])));
  return Buffer.concat([png.subarray(0, ihdrEnd), ...extra, png.subarray(ihdrEnd)]);
}

/** A 1×1 transparent PNG (the "fail" marker's body). */
export function onePixel(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function toPng(helper: string, data: Uint8Array, max: number): Promise<Buffer> {
  return new Promise((ok, err) => {
    const p = spawn(helper, ["thumb", String(max)], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", err);
    p.on("close", (code) => (code === 0 ? ok(Buffer.concat(out)) : err(new Error(`thumb exit ${code}`))));
    p.stdin.end(Buffer.from(data));
  });
}

export class Thumbnails {
  /** URIs written (or marked) in this session, with the mtime they were written for. */
  private readonly done = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  written = 0;
  failed = 0;
  constructor(
    readonly opts: { helper: string; mountpoint: string; core: ThumbCore; cacheDir?: string },
  ) {}

  private get root() {
    return this.opts.cacheDir ?? join(process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "", ".cache"), "thumbnails");
  }

  /** Where the file manager looks for this file's thumbnail of `size` ("normal" 128, "large" 256). */
  pathOf(uri: string, size: "normal" | "large" | "fail"): string {
    const name = createHash("md5").update(uri).digest("hex") + ".png";
    return size === "fail" ? join(this.root, "fail", "discordrive", name) : join(this.root, size, name);
  }

  /**
   * The thumbnails of a folder's files (after the file manager listed it): written in the background, one
   * at a time, each file once per mtime. `entries` are the folder's children with their path in the mount.
   */
  folder(entries: { id: string; path: string; kind: string; mtime: number }[]) {
    for (const e of entries) {
      if (e.kind !== "file") continue;
      const uri = fileUri(join(this.opts.mountpoint, e.path));
      const mt = Math.floor(e.mtime / 1000);
      if (this.done.get(uri) === mt) continue;
      this.done.set(uri, mt);
      this.queue = this.queue.then(() => this.one(e.id, uri, mt)).catch(() => {});
    }
    return this.queue;
  }

  private async one(id: string, uri: string, mtime: number) {
    const normal = this.pathOf(uri, "normal");
    if (existsSync(normal) || existsSync(this.pathOf(uri, "fail"))) return;
    const text = { "Thumb::URI": uri, "Thumb::MTime": String(mtime), Software: "discordrive" };
    const pv = (await this.opts.core.vdiskPreview(id, "t").catch(() => null)) ?? null;
    if (!pv) {
      // Nothing stored with the file (an old upload, not a picture): the file manager is told not to try.
      write(this.pathOf(uri, "fail"), withText(onePixel(), text));
      this.failed++;
      return;
    }
    const large = (await this.opts.core.vdiskPreview(id, "p").catch(() => null)) ?? pv;
    write(normal, withText(await toPng(this.opts.helper, pv.data, 128), text));
    write(this.pathOf(uri, "large"), withText(await toPng(this.opts.helper, large.data, 256), text));
    this.written++;
  }
}

function write(path: string, data: Buffer) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  // Atomically (the spec: a reader never sees half a file).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
