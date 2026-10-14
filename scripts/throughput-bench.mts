// Throughput of the transfer path without Discord's limits (zlecenie 2026-10-13-transfer §3):
// how many MB/s Node and Chromium really process per stage (read, AES-GCM encrypt/decrypt,
// SHA-256 WebCrypto and hash-wasm) and end to end (upload to / download from the local fake
// Discord over HTTP, pacer without limits). Answers whether the web UI could be the bottleneck at
// 600 Mb/s up / 900 Mb/s down (75 / 112 MB/s) or Discord is (~30 fragments/min per channel).
//
//   npx tsx scripts/throughput-bench.mts [--mb 200] [--channels 4] [--out file.json] [--label before]
// CHROMIUM_PATH as for check.ts. Writes the JSON result. The fake Discord runs in this Node process:
// the Node end-to-end numbers share one event loop with it (a lower bound); Chromium's do not.
import { build } from "esbuild";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSHA256 } from "hash-wasm";
import { Sequencer } from "@ddv4/sync-core";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { buildReport, parseLines } from "@ddv4/metadata-client/transfer-report";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const MB = Number(arg("mb", "200"));
const CHANNELS = Number(arg("channels", "4"));
const OUT = arg("out", "");
const LABEL = arg("label", "");
// Simulated Discord latency (ms): a 10 MiB webhook post answers after this long, a CDN read after cdn-ms.
const POST_MS = Number(arg("post-ms", "0"));
const CDN_MS = Number(arg("cdn-ms", "0"));
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Stage throughput on ~MB of data in 10 MiB fragments (same code path as the client). Runs in Node and in the page. */
const stagesSrc = async (D: typeof import("@ddv4/metadata-client"), createSHA: typeof createSHA256, mb: number) => {
  const FRAG = 10 * 1024 * 1024 - 28;
  const n = Math.max(1, Math.round((mb * 1e6) / FRAG));
  const buf = new Uint8Array(FRAG);
  for (let o = 0; o < buf.length; o += 65536) crypto.getRandomValues(buf.subarray(o, Math.min(buf.length, o + 65536)));
  const blob = typeof Blob !== "undefined" ? new Blob([buf]) : null;
  const key = await D.newFileKey();
  const now = () => performance.now();
  const rate = (bytes: number, ms: number) => Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10;
  const out: Record<string, number> = {};
  let t = now();
  if (blob) {
    for (let i = 0; i < n; i++) await blob.slice(0, FRAG).arrayBuffer();
    out.readBlob = rate(n * FRAG, now() - t);
  }
  t = now();
  let ct: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < n; i++) ct = await D.encryptFragment(key, buf);
  out.encrypt = rate(n * FRAG, now() - t);
  t = now();
  for (let i = 0; i < n; i++) await D.sha256Hex(ct);
  out.sha256WebCrypto = rate(n * ct.byteLength, now() - t);
  const h = await createSHA();
  h.init();
  t = now();
  for (let i = 0; i < n; i++) h.update(buf);
  h.digest("hex");
  out.sha256HashWasm = rate(n * FRAG, now() - t);
  t = now();
  for (let i = 0; i < n; i++) await D.decryptFragment(key, ct);
  out.decrypt = rate(n * FRAG, now() - t);
  t = now();
  for (let i = 0; i < n; i++) ct.slice();
  out.copy = rate(n * ct.byteLength, now() - t);
  // Whole upload pipeline per fragment, one at a time (read + encrypt + hash + hash-wasm): the CPU ceiling of one lane.
  const h2 = await createSHA();
  h2.init();
  t = now();
  for (let i = 0; i < n; i++) {
    const d = blob ? new Uint8Array(await blob.slice(0, FRAG).arrayBuffer()) : buf;
    const c = await D.encryptFragment(key, d);
    await D.sha256Hex(c);
    h2.update(d);
  }
  out.uploadCpuSerial = rate(n * FRAG, now() - t);
  return out;
};

/** Upload + download of `mb` MB through MetadataClient to the fake Discord (no limits), with the transfer log. */
const e2eSrc = async (D: typeof import("@ddv4/metadata-client"), apiOrigin: string, hooks: { id: string; url: string }[], mb: number, concurrency: number | undefined) => {
  const size = Math.round(mb * 1e6);
  const data = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(size, o + 65536)));
  const src = typeof Blob !== "undefined" ? (() => {
    const b = new Blob([data]);
    return { size: b.size, read: async (o: number, l: number) => new Uint8Array(await b.slice(o, o + l).arrayBuffer()) };
  })() : D.memorySource(data);
  const mem = new D.MemoryLogSink();
  const log = new D.TransferLog(mem.write, { src: typeof window !== "undefined" ? "web" : "cli", mode: "metadata-only" });
  const pacer = new D.ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 });
  const c = new D.MetadataClient({
    device: { id: "bench", name: "bench" },
    arbiter: new D.LocalArbiter(new ((globalThis as unknown as { __Seq: new () => never }).__Seq)()),
    transport: new D.DiscordWebhookTransport({ apiOrigin }),
    webhooks: hooks,
    pacer,
    ...(concurrency ? { concurrency } : {}),
  });
  c.setTransferLog(log);
  let t = performance.now();
  const up = await c.upload(src, "bench.bin");
  const upMs = performance.now() - t;
  t = performance.now();
  let got = 0;
  await c.download(up.nodeId, { write: async (d) => void (got += d.byteLength) });
  const downMs = performance.now() - t;
  const rate = (ms: number) => Math.round((size / 1e6 / (ms / 1000)) * 10) / 10;
  return { upMBps: rate(upMs), downMBps: rate(downMs), got, conc: c.uploadConcurrency, log: mem.text() };
};

async function main() {
  const res: Record<string, unknown> = { label: LABEL, at: new Date().toISOString(), mb: MB, channels: CHANNELS, postMs: POST_MS, cdnMs: CDN_MS, node: process.version };
  // ── Node
  res.nodeStages = await stagesSrc(await import("@ddv4/metadata-client"), createSHA256, MB);
  const fake = new FakeDiscord();
  fake.cdnCorsAll = true;
  fake.postDelayMs = POST_MS;
  fake.cdnDelayMs = CDN_MS;
  const origin = await fake.listen();
  const hooks = Array.from({ length: CHANNELS }, (_, i) => fake.addWebhook(String(1550000000000009000n + BigInt(i)))).map((h) => ({ id: h.id, url: h.url }));
  (globalThis as unknown as { __Seq: unknown }).__Seq = Sequencer;
  const D = await import("@ddv4/metadata-client");
  const ne = await e2eSrc(D, origin, hooks, MB, undefined);
  res.nodeE2e = { upMBps: ne.upMBps, downMBps: ne.downMBps, conc: ne.conc, report: summary(ne.log) };

  // ── Chromium: bundle the client + hash-wasm + sync-core for the page.
  const entry = join(here, "..", "packages", "metadata-client", "bench-entry.tmp.ts");
  writeFileSync(entry, `export * from "./src/index.js";\nexport { createSHA256 } from "hash-wasm";\nexport { Sequencer } from "@ddv4/sync-core";\n`);
  const bundle = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife", globalName: "DDN", write: false, logLevel: "error" });
  (await import("node:fs")).rmSync(entry);
  const page = createServer((_q, r) => (r.writeHead(200, { "content-type": "text/html" }), r.end("<!doctype html><title>bench</title>")));
  await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
  const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const p = await browser.newPage();
    await p.goto(pageOrigin);
    await p.addScriptTag({ content: "window.__name = (f) => f;" });
    await p.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await p.evaluate(() => void ((globalThis as unknown as { __Seq: unknown; DDN: { Sequencer: unknown } }).__Seq = (globalThis as unknown as { DDN: { Sequencer: unknown } }).DDN.Sequencer));
    res.chromiumStages = await p.evaluate(
      async ({ src, mb }) => {
        const D = (globalThis as unknown as { DDN: never }).DDN as { createSHA256: never };
        // eslint-disable-next-line no-new-func
        return (new Function(`return (${src})`)() as (a: unknown, b: unknown, c: number) => Promise<unknown>)(D, D.createSHA256, mb);
      },
      { src: stagesSrc.toString(), mb: MB },
    );
    const ce = (await p.evaluate(
      async ({ src, origin, hooks, mb }) => {
        const D = (globalThis as unknown as { DDN: never }).DDN;
        return (new Function(`return (${src})`)() as (...a: unknown[]) => Promise<unknown>)(D, origin, hooks, mb, undefined);
      },
      { src: e2eSrc.toString(), origin, hooks, mb: MB },
    )) as { upMBps: number; downMBps: number; conc: number; log: string };
    res.chromiumE2e = { upMBps: ce.upMBps, downMBps: ce.downMBps, conc: ce.conc, report: summary(ce.log) };
    res.chromiumHeapMB = r1(((await p.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)) as number) / 1e6);
  } finally {
    await browser.close();
    page.close();
    await fake.close();
  }
  console.log(JSON.stringify(res, null, 1));
  if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
}

function summary(log: string) {
  const { events } = parseLines(log);
  const r = buildReport(events, { bucketS: 1 });
  return { stages: r.summary.stages, requests: r.summary.requests, concurrency: r.summary.concurrency };
}

await main();
