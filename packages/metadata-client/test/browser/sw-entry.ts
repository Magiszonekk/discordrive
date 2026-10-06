/// <reference lib="webworker" />
// Service worker for stream-check.ts: builds a MetadataClient from state the
// page posts in (account key, encrypted log, fake Discord contents), then
// serves /ddn/file/<id> with Range from handleStreamRequest.
import { Sequencer } from "@ddv4/sync-core";
import { EncryptedArbiter, InProcessLogServer, MemoryTransport, MetadataClient, OpCodec, accountKeyFromB64, handleStreamRequest, type EncryptedEntry } from "../../src/index.js";

declare const self: ServiceWorkerGlobalScope;
let client: MetadataClient | null = null;
const cache = new Map<string, Uint8Array>();
let cdnFetches = 0;
let ranges = 0;

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e: ExtendableMessageEvent) => {
  e.waitUntil(
    (async () => {
      const m = e.data as { cmd: string; key: string; accountId: string; log: EncryptedEntry[]; blobs: [string, string, string, number[]][] };
      if (m.cmd === "stats") return e.ports[0]!.postMessage({ cdnFetches, cached: cache.size, ranges, manifestLoads: client?.manifestLoads ?? 0 });
      const transport = new MemoryTransport();
      // Rebuild the fake Discord: [messageId, webhookId, attachmentId, bytes]
      for (const [mid, wid, aid, bytes] of m.blobs) {
        const data = new Uint8Array(bytes);
        transport.messages.set(mid, { webhookId: wid, channelId: "c", attachments: [{ id: aid, data, filename: "x" }] });
        (transport as unknown as { blobs: Map<string, Uint8Array> }).blobs.set(aid, data);
      }
      const orig = transport.fetchCdn.bind(transport);
      transport.fetchCdn = async (u) => (cdnFetches++, orig(u));
      const server = new InProcessLogServer({ initialLog: m.log });
      const key = accountKeyFromB64(m.key);
      client = new MetadataClient({ device: { id: "sw", name: "sw" }, arbiter: new EncryptedArbiter(new OpCodec(key, m.accountId), server.session("sw")), transport, webhooks: [{ id: "1", url: "mem://" }] });
      await client.pull();
      void Sequencer;
      e.ports[0]!.postMessage({ ok: true, head: client.replica.headSeq });
    })(),
  );
});
self.addEventListener("fetch", (e: FetchEvent) => {
  if (!client) return;
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith("/ddn/file/")) return;
  ranges++;
  e.respondWith(handleStreamRequest(e.request, client, { cache, maxOpenRange: 96 * 1024 }).then((r) => r ?? fetch(e.request)));
});
