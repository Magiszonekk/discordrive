/// <reference lib="webworker" />
// Service worker: /ddn/file/<id> with Range. It has no
// keys or index itself; it asks a controlled page, which forwards to the app
// worker (AppCore.readRange). Keeps the single OPFS owner rule intact.
import { parseRange, STREAM_PREFIX, MAX_OPEN_RANGE } from "@ddv4/metadata-client";

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
  e.respondWith(
    (async () => {
      const nodeId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
      const size = Number(url.searchParams.get("size") ?? NaN);
      const range = Number.isFinite(size) ? parseRange(e.request.headers.get("range"), size, 4 * 1024 * 1024) : null;
      if (range === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      const start = range?.start ?? 0;
      const end = range?.end ?? start + MAX_OPEN_RANGE - 1;
      const r = await ask(e.clientId || e.resultingClientId, { ddn: "range", nodeId, start, end });
      if (!r.ok || !r.result) return new Response(r.error ?? "error", { status: 404 });
      const { data, size: total, start: s, end: en } = r.result;
      const whole = s === 0 && en === total - 1;
      return new Response(data as BodyInit, {
        status: whole ? 200 : 206,
        headers: { "accept-ranges": "bytes", "content-length": String(data.byteLength), ...(whole ? {} : { "content-range": `bytes ${s}-${en}/${total}` }) },
      });
    })(),
  );
});
