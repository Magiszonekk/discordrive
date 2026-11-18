// `ddn serve`: a local HTTP API on top of the same core as the command line. One process keeps the account
// open (the file list, the connections to Discord, the channel pacing), so scripts and services can send and
// read files without loading anything per request. Encryption stays here, like on any device of the account.
//
// Listens on 127.0.0.1:7777 by default; another address only with --listen (a warning is logged). Every
// request needs the local token (Authorization: Bearer …), made at the first start into a 0600 file. The
// token is not the API key: it only opens this service, and is never sent to the instance.
// Endpoints: docs/local-api.md (OpenAPI: docs/local-api.openapi.json).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { CLI_VERSION, classify, mkdirs, mustResolve, pathOfId, resolveRef, ROOTS, splitPath, type Ctx } from "./cli.js";
import { CliError, EXIT } from "./profile.js";

const DEFAULT_LISTEN = "127.0.0.1:7777";
/** Job records kept after they finished (GET /v1/jobs/<id>). */
const JOBS_KEPT = 500;
const MAX_RANGE = 64 * 1024 * 1024;

interface Job {
  id: string;
  kind: "upload";
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  name: string;
  folder: string;
  size: number;
  done: number;
  createdAt: number;
  finishedAt: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  /** Spool file of the request body (removed when the job ends). */
  spool: string;
  onConflict: "rename" | "replace" | "skip";
  waiters: (() => void)[];
  abort: AbortController;
}

class HttpErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function parseListen(v: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(v);
  if (!m || Number(m[2]) > 65535) throw new CliError(EXIT.usage, `--listen: HOST:PORT (e.g. ${DEFAULT_LISTEN})`);
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

/** The local token: from --token-file (made there if missing) or <profile>/serve-token, 0600. */
function localToken(c: Ctx): { token: string; file: string; made: boolean } {
  const file = (c.p.opts.get("--token-file") as string | undefined) ?? join(c.profile.dir, "serve-token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length < 32) throw new CliError(EXIT.usage, `${file}: the token must be at least 32 characters`);
    return { token: t, file, made: false };
  }
  const t = `ddnl_${randomBytes(32).toString("base64url")}`;
  writeFileSync(file, t + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
  return { token: t, file, made: true };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": b.byteLength, "cache-control": "no-store" });
  res.end(b);
}

/** Error answer: status from the failure, the same messages as the command line. */
function sendErr(res: ServerResponse, e: unknown) {
  if (res.headersSent) return void res.destroy(e instanceof Error ? e : undefined);
  if (e instanceof HttpErr) return sendJson(res, e.status, { error: e.code, message: e.message });
  const x = classify(e);
  const status = x.code === EXIT.notFound ? 404 : x.code === EXIT.usage ? 400 : x.code === EXIT.auth ? 503 : x.code === EXIT.limit ? 503 : x.code === EXIT.network ? 502 : 500;
  const code = x.code === EXIT.notFound ? "not_found" : x.code === EXIT.usage ? "bad_request" : x.code === EXIT.auth ? "key_refused" : x.code === EXIT.limit ? "no_channel_or_limit" : x.code === EXIT.network ? "upstream" : "failed";
  sendJson(res, status, { error: code, message: x.message });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const d of req) {
    n += (d as Buffer).byteLength;
    if (n > 1 << 20) throw new HttpErr(413, "body_too_large");
    parts.push(d as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpErr(400, "bad_json");
  }
}

/** Byte range of a Range header (one range; suffix and open ranges). null = whole file; throws 416 if outside. */
export function parseRangeHeader(h: string | undefined, size: number): { start: number; end: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) throw new HttpErr(416, "range_not_satisfiable");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) throw new HttpErr(416, "range_not_satisfiable");
  return { start, end };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain; charset=utf-8", json: "application/json", zip: "application/zip",
};
const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
const disposition = (name: string) => `inline; filename*=UTF-8''${encodeURIComponent(name)}`;

export async function serve(c: Ctx): Promise<number> {
  const listen = parseListen((c.p.opts.get("--listen") as string | undefined) ?? DEFAULT_LISTEN);
  const parallel = Math.max(1, Math.min(16, Number(c.p.opts.get("--parallel") ?? 2) || 2));
  const tok = localToken(c);
  const want = Buffer.from(tok.token);
  const log = (o: Record<string, unknown>) => c.io.err(JSON.stringify({ t: new Date().toISOString(), ...o }));
  if (!isLoopback(listen.host)) log({ ev: "warning", message: `listening on ${listen.host}, not only this computer: anyone who can reach it and has the local token can read and change the account's files` });

  // Transfer logs (docs/transfer-log.md, src "serve"): only with --transfer-log, without file names.
  if (c.p.opts.has("--transfer-log")) await c.core.setTransferLog(true, false);
  const spoolDir = join(c.profile.dir, "serve-spool");
  rmSync(spoolDir, { recursive: true, force: true });
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });

  // ── events (SSE) ─────────
  const listeners = new Set<ServerResponse>();
  const broadcast = (ev: string, data: unknown) => {
    const line = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of listeners) r.write(line);
  };
  c.core.onEvent = (e) => {
    if (e.type === "changed") broadcast("changed", { at: Date.now() });
    else if (e.type === "auth-lost") broadcast("auth-lost", { code: e.code });
  };

  // ── uploads: a queue, `parallel` at a time, in order ─────────
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = 0;
  let stopping = false;
  const finish = (j: Job, state: Job["state"]) => {
    j.state = state;
    j.finishedAt = Date.now();
    rmSync(j.spool, { force: true });
    for (const w of j.waiters.splice(0)) w();
    broadcast("job", publicJob(j));
    // Keep the last JOBS_KEPT finished ones.
    const done = [...jobs.values()].filter((x) => x.finishedAt !== null);
    for (const x of done.slice(0, Math.max(0, done.length - JOBS_KEPT))) jobs.delete(x.id);
    pump();
  };
  const pump = () => {
    while (!stopping && running < parallel && queue.length) {
      const j = queue.shift()!;
      if (j.state !== "queued") continue;
      running++;
      j.state = "running";
      broadcast("job", publicJob(j));
      let last = 0;
      void c.core
        .uploadFile(j.spool, j.folder, j.name, j.onConflict, (done) => {
          j.done = done;
          const t = Date.now();
          if (t - last > 500) ((last = t), broadcast("progress", { id: j.id, done, size: j.size }));
        }, j.abort.signal)
        .then((r) => {
          j.done = j.size;
          j.result = { id: r.nodeId, name: r.name, path: pathOfId(c, r.nodeId), size: r.size, sha256: r.sha256 || null, skipped: r.skipped, replaced: r.replaced, resumedPieces: r.resumed };
          log({ ev: "upload_done", job: j.id, size: r.size, skipped: r.skipped });
          finish(j, "done");
        })
        .catch((e: unknown) => {
          j.error = classify(e).message;
          log({ ev: "upload_failed", job: j.id, error: j.error });
          finish(j, j.abort.signal.aborted ? "cancelled" : "failed");
        })
        .finally(() => running--);
    }
  };
  const publicJob = (j: Job) => ({ id: j.id, kind: j.kind, state: j.state, name: j.name, folder: pathOfId(c, j.folder), size: j.size, done: j.done, createdAt: j.createdAt, finishedAt: j.finishedAt, result: j.result, error: j.error });

  // ── helpers over paths ─────────
  const space = (u: URL): Ctx => (u.searchParams.get("space") === "gallery" ? { ...c, space: "gallery" } : c);
  const nodeOf = (cc: Ctx, ref: string) => {
    const id = mustResolve(cc, ref);
    const n = cc.core.node(id);
    return { id, n };
  };
  const entry = (cc: Ctx, id: string) => {
    const n = cc.core.node(id);
    if (!n) return { id, name: "/", kind: "folder", size: null, modifiedAt: null, sha256: null, path: "/" };
    return { id: n.id, name: n.name, kind: n.kind, size: n.size, modifiedAt: n.modifiedAt, sha256: n.sha256, path: pathOfId(cc, n.id) };
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", "http://local");
    const method = req.method ?? "GET";
    // Every request carries the local token (also /v1/health: it says which account is open).
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const got = Buffer.from(auth ?? "");
    if (!auth || got.byteLength !== want.byteLength || !timingSafeEqual(got, want)) throw new HttpErr(401, "unauthorized", "local token missing or wrong (Authorization: Bearer <token from the token file>)");
    if (stopping && method !== "GET") throw new HttpErr(503, "stopping");
    const cc = space(u);
    const path = u.pathname;

    if (method === "GET" && path === "/v1/health") {
      const st = await c.core.status();
      const ch = await c.core.webhooks(false).catch(() => null);
      return sendJson(res, st.authLost ? 503 : 200, {
        ok: !st.authLost,
        version: CLI_VERSION,
        mode: c.profile.mode,
        accountId: st.accountId,
        deviceId: st.deviceId,
        connected: st.signedIn && !st.authLost,
        authLost: st.authLost,
        canUpload: ch ? ch.advice.ok : null,
        channels: ch ? ch.webhooks.length + (ch.using !== "own" ? (ch.pool?.channels ?? 0) : 0) : null,
        jobs: { queued: queue.filter((j) => j.state === "queued").length, running },
      });
    }

    if (method === "GET" && path === "/v1/list") {
      const ref = u.searchParams.get("path") ?? "/";
      const { id, n } = nodeOf(cc, ref);
      if (n && n.kind === "file") throw new HttpErr(400, "not_a_folder");
      const after = u.searchParams.get("after") ?? undefined;
      const limit = Math.max(1, Math.min(1000, Number(u.searchParams.get("limit") ?? 500) || 500));
      const page = cc.core.list(id, after, limit);
      return sendJson(res, 200, {
        path: pathOfId(cc, id),
        total: page.total,
        entries: page.rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, modifiedAt: r.modifiedAt, path: `${pathOfId(cc, id).replace(/\/$/, "")}/${r.name}` })),
        next: page.rows.length === limit ? page.rows.at(-1)!.cursor : null,
      });
    }

    if (method === "POST" && path === "/v1/folders") {
      const b = await readJsonBody(req);
      if (typeof b.path !== "string" || !splitPath(b.path).length) throw new HttpErr(400, "bad_path");
      const was = resolveRef(cc, b.path);
      if (was) {
        if (cc.core.node(was)?.kind !== "folder") throw new HttpErr(409, "exists_as_file");
        return sendJson(res, 200, { ...entry(cc, was), created: false });
      }
      const id = await mkdirs(cc, b.path);
      return sendJson(res, 201, { ...entry(cc, id), created: true });
    }

    if (method === "POST" && path === "/v1/move") {
      const b = await readJsonBody(req);
      const from = Array.isArray(b.from) ? b.from : typeof b.from === "string" ? [b.from] : null;
      if (!from || !from.length || from.some((x) => typeof x !== "string") || typeof b.to !== "string") throw new HttpErr(400, "bad_body", "{ from: path | path[], to: folder path, name?: new name (one item) }");
      const ids = (from as string[]).map((r) => mustResolve(cc, r));
      const to = mustResolve(cc, b.to);
      if (to !== ROOTS[cc.space] && cc.core.node(to)?.kind !== "folder") throw new HttpErr(400, "not_a_folder");
      if (ids.some((x) => cc.core.node(x)?.parentId !== to)) await cc.core.move(ids, to);
      if (typeof b.name === "string") {
        if (ids.length !== 1) throw new HttpErr(400, "name_needs_one_item");
        await cc.core.rename(ids[0]!, b.name);
      }
      return sendJson(res, 200, { moved: ids.map((x) => entry(cc, x)) });
    }

    if (method === "POST" && path === "/v1/files") {
      const folderRef = u.searchParams.get("path") ?? "/";
      const name = u.searchParams.get("name");
      const onConflict = (u.searchParams.get("on_conflict") ?? "rename") as Job["onConflict"];
      if (!name) throw new HttpErr(400, "name_required", "?name=<file name> (and ?path=<folder>)");
      if (!["rename", "replace", "skip"].includes(onConflict)) throw new HttpErr(400, "bad_on_conflict");
      if (/multipart\//i.test(req.headers["content-type"] ?? "")) throw new HttpErr(415, "raw_body_only", "send the file as the raw request body (Content-Type: application/octet-stream)");
      let folder = resolveRef(cc, folderRef);
      if (!folder) {
        if (u.searchParams.get("parents") !== "1") throw new HttpErr(404, "no_such_folder", `no such folder: ${folderRef} (?parents=1 makes it)`);
        folder = await mkdirs(cc, folderRef);
      }
      if (folder !== ROOTS[cc.space] && cc.core.node(folder)?.kind !== "folder") throw new HttpErr(400, "not_a_folder");
      const id = randomBytes(9).toString("base64url");
      const spool = join(spoolDir, id);
      // The body goes to a private file as it arrives (never whole into memory), then the core sends it piece
      // by piece; a failure after some pieces continues from them on the next try of the same file.
      await pipeline(req, createWriteStream(spool, { mode: 0o600 }));
      const size = statSync(spool).size;
      const len = req.headers["content-length"];
      if (len !== undefined && Number(len) !== size) {
        rmSync(spool, { force: true });
        throw new HttpErr(400, "body_incomplete");
      }
      const j: Job = { id, kind: "upload", state: "queued", name, folder, size, done: 0, createdAt: Date.now(), finishedAt: null, result: null, error: null, spool, onConflict, waiters: [], abort: new AbortController() };
      jobs.set(id, j);
      queue.push(j);
      broadcast("job", publicJob(j));
      pump();
      if (u.searchParams.get("wait") === "1") {
        await new Promise<void>((r) => (j.finishedAt !== null ? r() : j.waiters.push(r)));
        return sendJson(res, j.state === "done" ? 201 : 500, publicJob(j));
      }
      res.setHeader("location", `/v1/jobs/${id}`);
      return sendJson(res, 202, publicJob(j));
    }

    const jm = /^\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(path);
    if (jm) {
      const j = jobs.get(jm[1]!);
      if (!j) throw new HttpErr(404, "no_such_job");
      if (method === "DELETE") {
        if (j.state === "queued") finish(j, "cancelled");
        else if (j.state === "running") j.abort.abort();
        return sendJson(res, 202, publicJob(j));
      }
      if (method !== "GET") throw new HttpErr(405, "method_not_allowed");
      if (u.searchParams.get("wait") === "1" && j.finishedAt === null) await new Promise<void>((r) => j.waiters.push(r));
      return sendJson(res, 200, publicJob(j));
    }
    if (method === "GET" && path === "/v1/jobs") return sendJson(res, 200, { jobs: [...jobs.values()].map(publicJob) });

    if (method === "GET" && path === "/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: CLI_VERSION })}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => (clearInterval(ping), listeners.delete(res)));
      return;
    }

    // /v1/files/<id or path>: GET (Range), HEAD, DELETE (to the trash; ?permanent=1 for good)
    if (path.startsWith("/v1/files/")) {
      const ref = decodeURIComponent(path.slice("/v1/files/".length));
      const { id, n } = nodeOf(cc, ref.includes("/") || !ref ? `/${ref}` : ref);
      if (method === "DELETE") {
        if (id === ROOTS[cc.space]) throw new HttpErr(400, "cannot_remove_root");
        await cc.core.trash([id]);
        if (u.searchParams.get("permanent") === "1") await cc.core.purge([id]);
        return sendJson(res, 200, { ...entry(cc, id), trashed: true, permanent: u.searchParams.get("permanent") === "1" });
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpErr(405, "method_not_allowed");
      if (!n || n.kind !== "file") {
        if (u.searchParams.get("meta") === "1" || method === "HEAD") return sendJson(res, 200, entry(cc, id));
        throw new HttpErr(400, "not_a_file", "a folder: GET /v1/list?path=…");
      }
      if (u.searchParams.get("meta") === "1") return sendJson(res, 200, entry(cc, id));
      const size = n.size ?? 0;
      const range = parseRangeHeader(req.headers.range, size);
      const headers: Record<string, string | number> = {
        "content-type": mimeOf(n.name),
        "accept-ranges": "bytes",
        "content-disposition": disposition(n.name),
        "cache-control": "no-store",
        ...(n.sha256 ? { etag: `"${n.sha256}"` } : {}),
        "last-modified": new Date(n.modifiedAt ?? 0).toUTCString(),
      };
      if (!range) {
        res.writeHead(200, { ...headers, "content-length": size });
        if (method === "HEAD" || size === 0) return void res.end();
        const ac = new AbortController();
        res.on("close", () => !res.writableFinished && ac.abort());
        await c.core.downloadTo(id, { write: (d) => new Promise<void>((ok, bad) => res.write(d, (e) => (e ? bad(e) : ok()))) }, undefined, ac.signal);
        return void res.end();
      }
      res.writeHead(206, { ...headers, "content-length": range.end - range.start + 1, "content-range": `bytes ${range.start}-${range.end}/${size}` });
      if (method === "HEAD") return void res.end();
      // Only the pieces that overlap are fetched and decrypted, a slice at a time (a player seeks with this).
      for (let at = range.start; at <= range.end; ) {
        const to = Math.min(range.end, at + MAX_RANGE - 1);
        const r = await c.core.readRange(id, at, to);
        if (!res.write(r.data)) await new Promise((ok) => res.once("drain", ok));
        at = to + 1;
        if (res.destroyed) return;
      }
      return void res.end();
    }

    throw new HttpErr(404, "no_such_endpoint");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!(e instanceof HttpErr)) log({ ev: "request_failed", method: req.method, error: classify(e).message });
      sendErr(res, e);
    });
  });
  // Big uploads and long Range reads: no request timeout from Node.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((ok, bad) => {
    server.once("error", (e: NodeJS.ErrnoException) => bad(new CliError(EXIT.usage, e.code === "EADDRINUSE" ? `${listen.host}:${listen.port} is in use (--listen HOST:PORT)` : String(e.message))));
    server.listen(listen.port, listen.host, ok);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : listen.port;
  log({ ev: "listening", url: `http://${listen.host.includes(":") ? `[${listen.host}]` : listen.host}:${port}`, tokenFile: tok.file, tokenMade: tok.made, mode: c.profile.mode, parallel });
  if (!c.json) c.io.out(`ddn serve: http://${listen.host}:${port} (token in ${tok.file})`);
  else c.io.out(JSON.stringify({ event: "listening", host: listen.host, port, tokenFile: tok.file }));

  // Stop: SIGTERM / SIGINT (or the caller's signal): no new requests, the uploads already sending finish
  // (queued ones stay unsent: their bodies are dropped, the client sees "cancelled"); a second signal stops now.
  await new Promise<void>((done) => {
    let stops = 0;
    const stop = () => {
      stops++;
      if (stops > 1) return done();
      stopping = true;
      log({ ev: "stopping", running, queued: queue.length });
      for (const j of queue.splice(0)) finish(j, "cancelled");
      server.close();
      for (const r of listeners) r.end();
      const wait = () => (running === 0 ? done() : setTimeout(wait, 200));
      wait();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    c.io.stop?.addEventListener("abort", stop, { once: true });
  });
  server.closeAllConnections?.();
  rmSync(spoolDir, { recursive: true, force: true });
  log({ ev: "stopped" });
  return EXIT.ok;
}
