/// <reference lib="webworker" />
// Service worker: /ddn/file/<id> with Range (koncept §3.1). It has no
// keys or index itself; it asks a controlled page, which forwards to the app
// worker (AppCore.readRange). Keeps the single OPFS owner rule intact.
import { parseRange, STREAM_PREFIX, MAX_OPEN_RANGE } from "@ddv4/metadata-client";

declare const self: ServiceWorkerGlobalScope;
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

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
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
