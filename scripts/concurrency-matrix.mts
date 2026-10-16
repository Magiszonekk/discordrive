// Ceiling of the browser at high concurrency:
// headless Chromium uploads (and downloads) through MetadataClient to the local fake Discord without
// limits, for a grid of channels × fragments in flight, over HTTPS with HTTP/2 (like discord.com and
// its CDN: one multiplexed connection) and over HTTP/1.1 (6 connections per host in Chromium), with
// an optional simulated Discord request time. Reports MB/s, time per stage, the JS heap and the RSS of
// the browser's processes.
//   npx tsx scripts/concurrency-matrix.mts [--grid 4x3,4x8,8x16,15x30,30x60] [--mb 600] [--post-ms 0]
//        [--cdn-ms 0] [--proto h2,h1] [--down 4,16] [--out file.json]
import { build } from "esbuild";
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { buildReport, parseLines } from "@ddv4/metadata-client/transfer-report";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const GRID = arg("grid", "4x3,4x8,8x16,15x30,30x60").split(",").map((g) => g.split("x").map(Number) as [number, number]);
const MB = Number(arg("mb", "600"));
const POST_MS = Number(arg("post-ms", "0"));
const CDN_MS = Number(arg("cdn-ms", "0"));
const PROTOS = arg("proto", "h2,h1").split(",");
const DOWN = arg("down", "4,16").split(",").map(Number);
const OUT = arg("out", "");
const r1 = (x: number) => Math.round(x * 10) / 10;

function browserRss(): number {
  const rows = execSync("ps -e -o pid=,ppid=,rss=,comm=", { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, rss, comm]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss) / 1024, comm }));
  const kids = new Set<number>([process.pid]);
  for (let ch = true; ch; ) {
    ch = false;
    for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) ((kids.add(r.pid)), (ch = true));
  }
  return r1(rows.filter((r) => kids.has(r.pid) && /chrome/i.test(r.comm ?? "")).reduce((s, r) => s + r.rss, 0));
}

/** One run in the page: upload `mb` MB with `conc` in flight over `hooks`, then download with each of `down`. */
const runSrc = async (D: never, apiOrigin: string, hooks: { id: string; url: string }[], mb: number, conc: number, down: number[]) => {
  const DD = D as unknown as typeof import("@ddv4/metadata-client") & { Sequencer: new () => never };
  const size = Math.round(mb * 1e6);
  const g = globalThis as unknown as { __blob?: Blob; __blobSize?: number };
  if (g.__blobSize !== size) {
    const data = new Uint8Array(size);
    for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(size, o + 65536)));
    g.__blob = new Blob([data]);
    g.__blobSize = size;
  }
  const b = g.__blob!;
  const src = { size: b.size, read: async (o: number, l: number) => new Uint8Array(await b.slice(o, o + l).arrayBuffer()) };
  const mem = new DD.MemoryLogSink();
  const c = new DD.MetadataClient({
    device: { id: "bench", name: "bench" },
    arbiter: new DD.LocalArbiter(new DD.Sequencer()),
    transport: new DD.DiscordWebhookTransport({ apiOrigin }),
    webhooks: hooks,
    pacer: new DD.ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }),
    concurrency: conc,
  });
  c.setTransferLog(new DD.TransferLog(mem.write, { src: "web", mode: "metadata-only" }));
  const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  let peakHeap = heap();
  const timer = setInterval(() => void (peakHeap = Math.max(peakHeap, heap())), 100);
  let t = performance.now();
  const up = await c.upload(src, "bench.bin");
  const upMs = performance.now() - t;
  const downs: { conc: number; MBps: number }[] = [];
  for (const d of down) {
    c.setConcurrency({ download: d });
    t = performance.now();
    try {
      await c.download(up.nodeId, { write: async () => {} });
      downs.push({ conc: d, MBps: Math.round((size / 1e6 / ((performance.now() - t) / 1000)) * 10) / 10 });
    } catch (e) {
      downs.push({ conc: d, MBps: 0, err: String((e as Error)?.message ?? e).slice(0, 120) } as never);
    }
  }
  clearInterval(timer);
  return { upMBps: Math.round((size / 1e6 / (upMs / 1000)) * 10) / 10, downs, peakHeapMB: Math.round(peakHeap / 1e5) / 10, log: mem.text() };
};

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-matrix-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const tls = { key: readFileSync(join(work, "k.pem")), cert: readFileSync(join(work, "c.pem")) };
const entry = join(here, "..", "packages", "metadata-client", "matrix-entry.tmp.ts");
writeFileSync(entry, `export * from "./src/index.js";\nexport { Sequencer } from "@ddv4/sync-core";\n`);
const bundle = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife", globalName: "DDN", write: false, logLevel: "error" });
rmSync(entry);
const page = createServer((_q, r) => (r.writeHead(200, { "content-type": "text/html" }), r.end("<!doctype html><title>matrix</title>")));
await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--ignore-certificate-errors"] });
const rows: Record<string, unknown>[] = [];
try {
  for (const proto of PROTOS) {
    const fake = new FakeDiscord();
    fake.cdnCorsAll = true;
    fake.postDelayMs = POST_MS;
    fake.cdnDelayMs = CDN_MS;
    // h2: HTTPS + ALPN h2 (Chromium uses HTTP/2, one connection); h1: plain HTTP/1.1 (6 connections per host).
    const origin = await fake.listen(proto === "h2" ? { tls } : {});
    const allHooks = Array.from({ length: Math.max(...GRID.map((g) => g[0])) }, (_, i) => fake.addWebhook(String(1550000000000010000n + BigInt(i)))).map((h) => ({ id: h.id, url: h.url }));
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    await p.goto(pageOrigin);
    await p.addScriptTag({ content: "window.__name = (f) => f;" });
    await p.addScriptTag({ content: bundle.outputFiles[0]!.text });
    for (const [ch, conc] of GRID) {
      const rss0 = browserRss();
      let peakRss = rss0;
      const timer = setInterval(() => void (peakRss = Math.max(peakRss, browserRss())), 500);
      const mb = Math.max(MB, conc * 10.5 * 3);
      const r = (await p.evaluate(
        async ({ src, origin, hooks, mb, conc, down }) => {
          const D = (globalThis as unknown as { DDN: never }).DDN;
          return (new Function(`return (${src})`)() as (...a: unknown[]) => Promise<unknown>)(D, origin, hooks, mb, conc, down);
        },
        { src: runSrc.toString(), origin, hooks: allHooks.slice(0, ch), mb, conc, down: DOWN },
      )) as { upMBps: number; downs: { conc: number; MBps: number }[]; peakHeapMB: number; log: string };
      clearInterval(timer);
      const rep = buildReport(parseLines(r.log).events, { bucketS: 1 });
      const st = rep.summary.stages["web/up"] ?? {};
      const row = { proto, channels: ch, conc, mb: r1(mb), upMBps: r.upMBps, upMbps: Math.round(r.upMBps * 8), downs: r.downs, inFlightAvg: rep.summary.concurrency["web/up"]?.avg, req_p50_ms: rep.summary.requests["web/up/post"]?.p50, stage_ms: { rd: st.rd, enc: st.enc, hash: st.hash, put: st.put }, peakHeapMB: r.peakHeapMB, browserRssMB: { before: rss0, peak: peakRss } };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    await ctx.close();
    await fake.close();
  }
} finally {
  await browser.close();
  page.close();
  rmSync(work, { recursive: true, force: true });
}
const res = { at: new Date().toISOString(), postMs: POST_MS, cdnMs: CDN_MS, cpus: Number(execSync("nproc", { encoding: "utf8" }).trim()), rows };
if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
