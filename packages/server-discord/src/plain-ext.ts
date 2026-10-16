// Plain mode, server side: the server reads the operation log
// (PlainOpCodec) and keeps its own replica of every account's index, so it knows names, the
// tree and the file keys. On top of the e2ee parts (blobs through the instance, background
// work) it adds:
//   GET  /v1/plain/search?q=      search by name (server side, name_key + LIKE)
//   GET  /v1/plain/thumb/<node>   thumbnail (image / video frame) made with ffmpeg in the
//                                 background after the upload, cached in <dataDir>/thumbs
//   POST /v1/plain/stream/<node>  short-lived ticket for <video src> (no headers in a video tag)
//   GET  /v1/plain/file/<node>?t= the plaintext with HTTP Range, decrypted on the server
//                                 (only the fragments that overlap the range are fetched)
// Ported from ddrive (thumbnail.ts, stream.ts), with its RAM lesson applied: a thumbnail
// input is streamed to a temp file fragment by fragment (videos: only the first fragments),
// never the whole file in memory. ffmpeg/ffprobe are optional: without them thumbnails are off
// and `doctor`/setup say how to install them.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_ID, applyEntries, initIndex, nameKey, type FileVersion, type NodeRecord } from "@ddv4/sync-core";
import { decryptFragment, importFileKey, decryptManifest, decodeManifestRef, sha256Hex, isDiscordPlacement, type Placement, type EncryptedEntry, type FileKey } from "@ddv4/metadata-client";
import type { ChunkManifest } from "@ddv4/sync-core";
import { PlainOpCodec } from "@ddv4/metadata-client/plain-ops";
import { SqliteIndexStore } from "@ddv4/metadata-client/node";
import { HttpError, type DdnServer, type ExtRequest, type ServerExtension } from "@ddv4/metadata-client/node";
import type { BlobsExtension } from "./blobs-ext.js";

export const THUMB_MAX_DIM = 320;
/** A video frame is taken from the first fragments only (a few seconds in), never the whole file. */
export const VIDEO_THUMB_MAX_BYTES = 24 * 1024 * 1024;
const STREAM_TICKET_MS = 6 * 3600_000;
const MIME: Record<string, string> = {
  webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  mp3: "audio/mpeg", ogg: "audio/ogg", txt: "text/plain; charset=utf-8", pdf: "application/pdf",
};
export const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
const isImage = (n: string) => mimeOf(n).startsWith("image/");
const isVideo = (n: string) => mimeOf(n).startsWith("video/");

/** ffmpeg + ffprobe on PATH (or DDN_FFMPEG / DDN_FFPROBE). */
export function findFfmpeg(): { ffmpeg: string; ffprobe: string } | null {
  const ffmpeg = process.env.DDN_FFMPEG || "ffmpeg";
  const ffprobe = process.env.DDN_FFPROBE || "ffprobe";
  const ok = (bin: string) => {
    try {
      return spawnSync(bin, ["-version"], { stdio: "ignore", timeout: 10_000, windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  };
  return ok(ffmpeg) && ok(ffprobe) ? { ffmpeg, ffprobe } : null;
}

function run(bin: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => (clearTimeout(t), reject(e)));
    p.on("close", (code) => (clearTimeout(t), code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-500)}`))));
  });
}

interface Replica {
  store: SqliteIndexStore;
  codec: PlainOpCodec;
}

export interface PlainExtensionOptions {
  dataDir: string;
  blobs: BlobsExtension;
  /** Background thumbnail generation (default: on when ffmpeg is found). */
  thumbnails?: boolean;
  log?: (s: string) => void;
}

export class PlainExtension implements ServerExtension {
  readonly name = "plain";
  private srv!: DdnServer;
  private readonly replicas = new Map<string, Replica>();
  private readonly ff: { ffmpeg: string; ffprobe: string } | null;
  private readonly thumbDir: string;
  private readonly replicaDir: string;
  private readonly queue: { acct: string; nodeId: string }[] = [];
  private working = false;
  private readonly tickets = new Map<string, { acct: string; nodeId: string; until: number }>();
  readonly stats = { thumbs: 0, thumbErrors: 0, applied: 0, rangeReads: 0 };
  /** Resolves when the thumbnail queue is empty (tests). */
  idle: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | null = null;

  constructor(readonly o: PlainExtensionOptions) {
    this.ff = o.thumbnails === false ? null : findFfmpeg();
    this.thumbDir = join(o.dataDir, "thumbs");
    this.replicaDir = join(o.dataDir, "replicas");
  }

  init(srv: DdnServer): void {
    this.srv = srv;
    mkdirSync(this.thumbDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.replicaDir, { recursive: true, mode: 0o700 });
  }

  async close(): Promise<void> {
    for (const r of this.replicas.values()) r.store.close();
    this.replicas.clear();
  }

  health(): Record<string, unknown> {
    return { plain: { thumbnails: !!this.ff, search: true, rangeStreaming: true } };
  }

  /** The account's replica, caught up with the server log. */
  replica(acct: string): Replica {
    let r = this.replicas.get(acct);
    if (!r) {
      if (!/^[a-z]+-[A-Za-z0-9_-]{22}$/.test(acct)) throw new HttpError(400, "bad_account");
      const store = new SqliteIndexStore(join(this.replicaDir, `${acct}.db`));
      initIndex(store);
      r = { store, codec: new PlainOpCodec(acct) };
      this.replicas.set(acct, r);
    }
    const head = this.srv.logHead(acct);
    let at = r.store.getMeta().headSeq;
    while (at < head) {
      const batch: EncryptedEntry[] = this.srv.logRead(acct, at, 1000);
      if (!batch.length) break;
      const rr = r;
      const results = rr.store.atomically(() => applyEntries(rr.store, batch.map((e) => rr.codec.decodeSync(e))));
      this.stats.applied += results.length;
      for (let i = 0; i < batch.length; i++) {
        const op = rr.codec.decodeSync(batch[i]!).op as { type: string; ops?: { type: string; nodeId?: string; content?: unknown }[]; nodeId?: string; content?: unknown };
        const touched = op.type === "group" ? (op.ops ?? []) : [op];
        for (const x of touched) if ((x.type === "create" || x.type === "new_content_version") && x.content && x.nodeId) this.enqueueThumb(acct, x.nodeId);
      }
      at = r.store.getMeta().headSeq;
    }
    return r;
  }

  onAppend(acct: string): void {
    // Keep the replica close to the log (thumbnails start right after the commit).
    try {
      this.replica(acct);
    } catch (e) {
      this.o.log?.(`plain replica ${acct}: ${(e as Error).message}`);
    }
  }

  // --- reading files on the server

  private readonly manifests = new Map<string, Promise<{ manifest: ChunkManifest; key: FileKey }>>();
  private loadManifest(acct: string, ref: string): Promise<{ manifest: ChunkManifest; key: FileKey }> {
    let p = this.manifests.get(ref);
    if (!p) {
      p = (async () => {
        const loc = decodeManifestRef(ref);
        const key = await importFileKey(loc.k);
        return { manifest: await decryptManifest(key, await this.readPlacement(acct, loc.at)), key };
      })();
      this.manifests.set(ref, p);
      p.catch(() => this.manifests.delete(ref));
      while (this.manifests.size > 512) this.manifests.delete(this.manifests.keys().next().value!);
    }
    return p;
  }

  private async readPlacement(acct: string, p: Placement): Promise<Uint8Array> {
    // The instance stores on its own Discord webhooks only.
    if (!isDiscordPlacement(p)) throw new HttpError(404, "no_such_blob");
    const row = this.o.blobs.blobByAttachment(acct, p.attachmentId);
    if (!row) throw new HttpError(404, "no_such_blob");
    return this.o.blobs.readBlob(row);
  }

  /** Plaintext fragment i of a version (hash-checked, decrypted). */
  private async fragment(acct: string, v: FileVersion, i: number): Promise<Uint8Array> {
    const { manifest, key } = await this.loadManifest(acct, v.manifestRef);
    const c = [...manifest.chunks].sort((a, b) => a.index - b.index)[i];
    if (!c) throw new HttpError(416, "no_such_fragment");
    const ct = await this.readPlacement(acct, c.placements![0] as Placement);
    if (c.ciphertextHash && (await sha256Hex(ct)) !== c.ciphertextHash) throw new Error(`fragment ${i}: hash mismatch`);
    return decryptFragment(key, ct);
  }

  private file(acct: string, nodeId: string): NodeRecord & { content: FileVersion } {
    const n = this.replica(acct).store.getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new HttpError(404, "no_such_file");
    return n as NodeRecord & { content: FileVersion };
  }

  // --- thumbnails

  private thumbPath(acct: string, versionId: string): string {
    return join(this.thumbDir, `${acct}-${versionId}.jpg`);
  }

  private enqueueThumb(acct: string, nodeId: string): void {
    if (!this.ff) return;
    this.queue.push({ acct, nodeId });
    if (!this.working) {
      this.idle = new Promise((r) => (this.idleResolve = r));
      this.working = true;
      setImmediate(() => void this.drain());
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const j = this.queue.shift()!;
      try {
        await this.makeThumb(j.acct, j.nodeId);
      } catch (e) {
        this.stats.thumbErrors++;
        this.o.log?.(`thumbnail: ${(e as Error).message}`);
      }
    }
    this.working = false;
    this.idleResolve?.();
  }

  /** ffmpeg on a temp copy written fragment by fragment (videos: only the first VIDEO_THUMB_MAX_BYTES). */
  async makeThumb(acct: string, nodeId: string): Promise<string | null> {
    if (!this.ff) return null;
    let n: NodeRecord & { content: FileVersion };
    try {
      n = this.file(acct, nodeId);
    } catch {
      return null;
    }
    if (!isImage(n.name) && !isVideo(n.name)) return null;
    const out = this.thumbPath(acct, n.content.versionId);
    if (existsSync(out)) return out;
    const dir = await mkdtemp(join(tmpdir(), "ddn-thumb-"));
    try {
      const input = join(dir, `in.${n.name.split(".").pop()}`);
      const ws = createWriteStream(input);
      const { manifest } = await this.loadManifest(acct, n.content.manifestRef);
      let written = 0;
      for (let i = 0; i < manifest.chunks.length; i++) {
        if (isVideo(n.name) && written >= VIDEO_THUMB_MAX_BYTES) break;
        const pt = await this.fragment(acct, n.content, i);
        await new Promise<void>((ok, bad) => ws.write(pt, (e) => (e ? bad(e) : ok())));
        written += pt.byteLength;
      }
      await new Promise<void>((ok) => ws.end(ok));
      const scale = `scale='min(${THUMB_MAX_DIM},iw)':'min(${THUMB_MAX_DIM},ih)':force_original_aspect_ratio=decrease`;
      let seek = 0;
      if (isVideo(n.name)) {
        // ddrive: a frame ~10 % in, at least 0.5 s (here within the part we have).
        const d = Number((await run(this.ff.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input]).catch(() => "0")).trim());
        seek = Number.isFinite(d) && d > 0 ? Math.max(0.5, Math.min(d * 0.1, 10)) : 1;
      }
      const tmpOut = join(dir, "thumb.jpg");
      const args = ["-y", "-v", "error", ...(seek ? ["-ss", String(seek)] : []), "-i", input, "-vf", scale, "-frames:v", "1", "-q:v", "5", tmpOut];
      await run(this.ff.ffmpeg, args).catch(async (e) => {
        if (!seek) throw e;
        await run(this.ff!.ffmpeg, ["-y", "-v", "error", "-i", input, "-vf", scale, "-frames:v", "1", "-q:v", "5", tmpOut]); // too short for the seek
      });
      renameSync(tmpOut, out);
      this.stats.thumbs++;
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- routes

  async route(r: ExtRequest): Promise<boolean> {
    const { method, path, url } = r;
    if (!path.startsWith("/v1/plain/")) return false;
    const file = /^\/v1\/plain\/file\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (file && (method === "GET" || method === "HEAD")) {
      // Ticket (video tag) or session (fetch).
      const tk = url.searchParams.get("t");
      let acct: string;
      if (tk) {
        const t = this.tickets.get(tk);
        if (!t || t.until < this.srv.clock() || t.nodeId !== file[1]) throw new HttpError(403, "bad_ticket");
        acct = t.acct;
      } else acct = r.session().accountId;
      await this.serveRange(r, acct, file[1]!);
      return true;
    }
    const s = r.session();
    if (method === "GET" && path === "/v1/plain/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q || q.length > 200) throw new HttpError(400, "bad_query");
      const rep = this.replica(s.accountId);
      const k = nameKey(q);
      const hits: { id: string; name: string; kind: string; parentId: string | null; size: number | null }[] = [];
      for (const n of rep.store.allNodes()) {
        if (n.id === ROOT_ID || n.trashed || !n.parentId) continue;
        if (nameKey(n.name).includes(k)) hits.push({ id: n.id, name: n.name, kind: n.kind, parentId: n.parentId, size: n.content?.sizeBytes ?? null });
        if (hits.length >= 200) break;
      }
      r.send(200, { q, hits: hits.sort((a, b) => (a.name < b.name ? -1 : 1)) });
      return true;
    }
    const th = /^\/v1\/plain\/thumb\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (th && method === "GET") {
      const n = this.file(s.accountId, th[1]!);
      const p = this.thumbPath(s.accountId, n.content.versionId);
      if (!existsSync(p)) {
        if (!this.ff) throw new HttpError(404, "thumbnails_off");
        this.enqueueThumb(s.accountId, th[1]!);
        throw new HttpError(404, "thumbnail_pending");
      }
      const b = readFileSync(p);
      r.res.writeHead(200, { "content-type": "image/jpeg", "content-length": b.byteLength, "cache-control": "private, max-age=86400" });
      r.res.end(b);
      return true;
    }
    const st = /^\/v1\/plain\/stream\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (st && method === "POST") {
      this.file(s.accountId, st[1]!);
      const t = randomBytes(24).toString("base64url");
      const now = this.srv.clock();
      for (const [k, v] of this.tickets) if (v.until < now) this.tickets.delete(k);
      this.tickets.set(t, { acct: s.accountId, nodeId: st[1]!, until: now + STREAM_TICKET_MS });
      r.send(200, { url: `/v1/plain/file/${st[1]}?t=${t}` });
      return true;
    }
    return false;
  }

  /** HTTP Range on the plaintext: fetch and decrypt only the fragments that overlap. */
  private async serveRange(r: ExtRequest, acct: string, nodeId: string): Promise<void> {
    const n = this.file(acct, nodeId);
    const size = n.content.sizeBytes;
    const { manifest } = await this.loadManifest(acct, n.content.manifestRef);
    const cs = manifest.chunkSizeBytes;
    const h = r.req.headers.range;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (h) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
      if (!m || (!m[1] && !m[2])) throw new HttpError(416, "bad_range", { "content-range": `bytes */${size}` });
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(size - 1, start + 4 * cs - 1);
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start >= size || end < start) throw new HttpError(416, "bad_range", { "content-range": `bytes */${size}` });
      partial = true;
    }
    this.stats.rangeReads++;
    const headers: Record<string, string | number> = {
      "content-type": mimeOf(n.name),
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(n.name)}`,
      ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    };
    r.res.writeHead(partial ? 206 : 200, headers);
    if (r.method === "HEAD" || size === 0) return void r.res.end();
    for (let i = Math.floor(start / cs); i <= Math.floor(end / cs); i++) {
      if (r.res.destroyed) return;
      const pt = await this.fragment(acct, n.content, i);
      const from = Math.max(start, i * cs) - i * cs;
      const to = Math.min(end, i * cs + pt.byteLength - 1) - i * cs;
      if (!r.res.write(pt.subarray(from, to + 1))) await new Promise((ok) => r.res.once("drain", ok));
    }
    r.res.end();
  }
}

