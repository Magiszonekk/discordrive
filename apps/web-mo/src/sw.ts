/// <reference lib="webworker" />
// Service worker: /ddn/file/<id> with Range. It has no
// keys or index itself; it asks a controlled page, which forwards to the app
// worker (AppCore.readRange). Keeps the single OPFS owner rule intact.
import { guessType, parseRange, STREAM_PREFIX } from "@ddv4/metadata-client";

declare const self: ServiceWorkerGlobalScope;
// The app worker is not this worker's client (it lives under /w/, see w-sw.ts): its uploads must not pass here.
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function ask(clientId: string, msg: unknown): Promise<{ ok: boolean; result?: { data: Uint8Array; size: number; start: number; end: number; name: string }; error?: string }> {
  const c = (await self.clients.get(clientId)) ?? (await self.clients.matchAll({ type: "window" }))[0];
  if (!c) return { ok: false, error: "no page" };
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    c.postMessage(msg, [ch.port2]);
  });
}

// ── streamed downloads ──
// The page hands over a MessagePort whose other end is the app worker, then opens
// /ddn/download/<token> in a hidden frame; the response streams the decrypted file, one fragment per
// pull (backpressure down to the fragment fetches), and the browser saves it as a download.
const DOWNLOAD_PREFIX = "/ddn/download/";
const pending = new Map<string, { port: MessagePort; name: string; size: number; mime: string; at: number }>();
self.addEventListener("message", (e: ExtendableMessageEvent) => {
  const m = e.data as { ddn?: string; token?: string; name?: string; size?: number; mime?: string };
  if (m?.ddn === "dl" && m.token && e.ports[0]) {
    for (const [k, v] of pending) if (Date.now() - v.at > 120_000) pending.delete(k);
    pending.set(m.token, { port: e.ports[0], name: m.name ?? "download", size: Number(m.size) || 0, mime: m.mime || "application/octet-stream", at: Date.now() });
  }
  // m.ddn === "ping": keeps this worker alive during a long download (nothing to do).
});

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function streamed(token: string): Promise<Response> {
  // The page posts the port right before it opens the frame: give the message a moment to arrive.
  for (let i = 0; i < 40 && !pending.has(token); i++) await new Promise((r) => setTimeout(r, 50));
  const d = pending.get(token);
  if (!d) return new Response("unknown download", { status: 404 });
  pending.delete(token);
  let wake: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        d.port.onmessage = (ev: MessageEvent<{ chunk?: ArrayBuffer; done?: boolean; error?: string }>) => {
          const m = ev.data;
          if (m.chunk) c.enqueue(new Uint8Array(m.chunk));
          else if (m.done) c.close();
          else if (m.error) c.error(new Error(m.error));
          wake?.();
          wake = null;
        };
      },
      pull() {
        return new Promise<void>((r) => {
          wake = r;
          d.port.postMessage({ pull: true });
        });
      },
      cancel() {
        d.port.postMessage({ cancel: true });
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": d.mime, "content-disposition": disposition(d.name), ...(d.size ? { "content-length": String(d.size) } : {}), "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith(DOWNLOAD_PREFIX) && e.request.method === "GET") return void e.respondWith(streamed(decodeURIComponent(url.pathname.slice(DOWNLOAD_PREFIX.length))));
  if (!url.pathname.startsWith(STREAM_PREFIX) || e.request.method !== "GET") return;
  e.respondWith(media(url, e.request.headers.get("range"), e.clientId || e.resultingClientId));
});

/** Bytes per request to the page (about a fragment). */
const WINDOW = 4 * 1024 * 1024;
/**
 * /ddn/file/<id>: a Range answered window by window from the app worker. An open range ("bytes=N-", what
 * players send) gets the WHOLE rest of the file as a stream, pulled only as fast as the player reads (a seek
 * cancels it): a shorter answer to an open range is taken as the end of the file, and an MP4 whose `moov`
 * is at the end then fails to open.
 */
async function media(url: URL, rangeHeader: string | null, clientId: string): Promise<Response> {
  const nodeId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
  let size = Number(url.searchParams.get("size") ?? NaN);
  const range = Number.isFinite(size) && size > 0 ? parseRange(rangeHeader, size, Number.MAX_SAFE_INTEGER) : null;
  if (range === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const start = range?.start ?? 0;
  const first = await ask(clientId, { ddn: "range", nodeId, start, end: start + WINDOW - 1 });
  if (!first.ok || !first.result) return new Response(first.error ?? "error", { status: 404 });
  size = first.result.size;
  const end = range ? Math.min(range.end, size - 1) : size - 1;
  const whole = !rangeHeader && start === 0 && end === size - 1;
  let next = start;
  let pending: Uint8Array | null = first.result.data.subarray(0, Math.min(first.result.data.byteLength, end - start + 1));
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        let d = pending;
        pending = null;
        if (!d) {
          const r = await ask(clientId, { ddn: "range", nodeId, start: next, end: Math.min(end, next + WINDOW - 1) });
          if (!r.ok || !r.result || !r.result.data.byteLength) return c.error(new Error(r.error ?? "read failed"));
          d = r.result.data;
        }
        next += d.byteLength;
        c.enqueue(d);
        if (next > end) c.close();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: whole ? 200 : 206,
    // The type matters: an MP4 whose `moov` is at the end starts with `mdat` and is not sniffed.
    headers: { "accept-ranges": "bytes", "content-type": guessType(first.result.name), "content-length": String(end - start + 1), ...(whole ? {} : { "content-range": `bytes ${start}-${end}/${size}` }) },
  });
}
