// Video streaming through a service worker in headless Chromium:
// a real WebM is uploaded (encrypted, 64 KiB fragments) in Node; the page
// installs a service worker that decrypts fragments on demand and answers
// Range requests; <video> must load metadata, play, and seek near the end
// without fetching every fragment.
import { build } from "esbuild";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedArbiter, InProcessLogServer, MemoryTransport, MetadataClient, OpCodec, memorySource, newAccountKey } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-stream-"));
const video = join(dir, "v.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=20", "-c:v", "libvpx-vp9", "-b:v", "600k", "-deadline", "realtime", "-cpu-used", "8", video]);
const bytes = new Uint8Array(readFileSync(video));

const key = newAccountKey();
const ACCT = "acct-stream";
const server = new InProcessLogServer();
const transport = new MemoryTransport();
const c = new MetadataClient({ device: { id: "dev-up", name: "up" }, arbiter: new EncryptedArbiter(new OpCodec(key, ACCT), server.session("dev-up")), transport, webhooks: [{ id: "1", url: "mem://" }], chunkSize: 64 * 1024, sleep: async () => {} });
const up = await c.upload(memorySource(bytes), "film.webm");
const blobs = [...transport.messages].map(([mid, m]) => [mid, m.webhookId, m.attachments[0]!.id, [...m.attachments[0]!.data]]);

const sw = (await build({ entryPoints: [join(here, "sw-entry.ts")], bundle: true, platform: "browser", format: "iife", write: false, logLevel: "error" })).outputFiles[0]!.text;
const page = `<!doctype html><video id=v muted preload=metadata></video>`;
const srv = createServer((q, r) => {
  if (q.url === "/sw.js") return r.writeHead(200, { "content-type": "text/javascript" }), r.end(sw);
  r.writeHead(200, { "content-type": "text/html" });
  r.end(page);
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = false;
try {
  const p = await browser.newPage();
  await p.addInitScript({ content: "window.__name = (f) => f;" }); // tsx wraps named fns in __name()
  await p.goto(origin);
  const result = await p.evaluate(
    async ({ state, nodeId }) => {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      while (!navigator.serviceWorker.controller) await new Promise((r) => setTimeout(r, 50));
      const ask = (msg: unknown) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data);
          reg.active!.postMessage(msg, [ch.port2]);
        });
      await ask(state);
      const v = document.getElementById("v") as HTMLVideoElement;
      const ev = (name: string) => new Promise((r) => v.addEventListener(name, r, { once: true }));
      v.src = `/ddn/file/${nodeId}`;
      await ev("loadedmetadata");
      const duration = v.duration;
      const atMetadata = await ask({ cmd: "stats" });
      await v.play();
      await new Promise((r) => setTimeout(r, 500));
      const playedTo = v.currentTime;
      v.pause();
      v.currentTime = duration - 1;
      await ev("seeked");
      const afterSeek = v.currentTime;
      const stats = await ask({ cmd: "stats" });
      return { duration, playedTo, afterSeek, videoWidth: v.videoWidth, error: v.error?.message ?? null, cdnFetches: Number(stats.cdnFetches), cached: Number(stats.cached), requests: Number(stats.ranges), manifestLoads: Number(stats.manifestLoads), fetchesAtMetadata: Number(atMetadata.cdnFetches) };
    },
    { state: { cmd: "init", key: key.rawB64, accountId: ACCT, log: server.log.read(0), blobs }, nodeId: up.nodeId },
  );
  const out = { fileBytes: bytes.byteLength, fragments: up.chunks, ...result };
  console.log(JSON.stringify(out));
  ok =
    !out.error &&
    out.duration > 19 &&
    out.duration < 21 &&
    out.playedTo > 0.1 &&
    Math.abs(out.afterSeek - (out.duration - 1)) < 1.5 &&
    out.videoWidth === 320 &&
    out.requests > 1 && // the player really used ranged requests
    out.manifestLoads === 1 &&
    out.fetchesAtMetadata < up.chunks; // metadata did not need the whole file
} finally {
  await browser.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
