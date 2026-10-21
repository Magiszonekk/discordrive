// Upload and download of one file through MetadataClient in headless Chromium against REAL Discord
// webhooks (a test server: one webhook per channel), with the transfer log on. Measures what the web
// app does on this machine's line: upload MB/s with the default (automatic) fragments in flight, then
// downloads with each setting from --down ("auto" = the default). The page bundles the client from
// this checkout, so the same command measures the code before and after a change.
//
//   npx tsx scripts/live-transfer-bench.mts webhooks.txt [--mb 1000] [--down auto,16] [--up auto]
//        [--files 1] [--out dir] [--label before] [--speedtest] [--seed 1] [--drop-posts 20,40]
//        [--browser-args "--disable-quic"] [--lane]
//
// The file is generated on the fly from a seed (no Blob of the whole size: a 1 GB Blob is written to the
// temporary browser profile's disk and a system Chromium/Brave failed to read it back). --speedtest
// first measures the line itself (speed.cloudflare.com, 8 streams, ~8 s each way, from this process),
// so the result can be compared with what the line does. CHROMIUM_PATH = the browser to run.
// --drop-posts 20,40: those webhook posts (numbers in the order they are sent) fail with "Failed to fetch"
// before leaving the page, as a connection reset would; the client retries them. Shows what isolated
// network errors do to the speed (the same posts fail in a run of any version).
// --browser-args "...": extra command-line switches for the browser (e.g. --disable-quic: HTTP/2 over
// TCP instead of HTTP/3 = QUIC, which Chromium uses with Discord by default).
// --lane: downloads may also use a second connection, a hidden sandboxed iframe like the app's lane.html
// (its opaque origin gets its own connections), so the bench measures what the app does.
// The summary says which protocol the requests used (h3 / h2 / http/1.1 per host and per connection:
// page or lane, from the browser's own network events through DevTools: Discord sends no
// Timing-Allow-Origin, so the page's Resource Timing shows no protocol) and the build of the client.
//
// webhooks.txt: webhook URLs of a TEST server, one per line. Every posted message is deleted at the
// end. The output (summary JSON, transfer logs, report text) has no webhook tokens or CDN links.
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, parseLines } from "@ddv4/metadata-client/transfer-report";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const file = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!file) {
  console.error("usage: npx tsx scripts/live-transfer-bench.mts webhooks.txt [--mb 1000] [--down auto,16] [--up auto] [--files 1] [--out dir] [--label x] [--speedtest] [--seed 1]");
  process.exit(2);
}
const MB = Number(arg("mb", "1000"));
const DOWN = arg("down", "auto,16").split(",");
const UP = arg("up", "auto");
// --files N: N uploads of the same size, one after another (the last one is downloaded); shows the next file
// starting from what the automatic value learned on the previous one.
const FILES = Math.max(1, Number(arg("files", "1")));
const OUT = arg("out", "");
const LABEL = arg("label", "run");
const SEED = Number(arg("seed", "1")) >>> 0;
const SPEEDTEST = argv.includes("--speedtest");
const DROP = arg("drop-posts", "").split(",").map(Number).filter((n) => n > 0);
const BROWSER_ARGS = arg("browser-args", "").split(/\s+/).filter(Boolean);
const LANE = argv.includes("--lane");
const { buildId, sourceHash } = await import("../apps/web-mo/source-hash.js");
const BUILD = buildId(sourceHash());
const HOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/[A-Za-z0-9_.-]+$/;
const hooks = readFileSync(file, "utf8").split(/\s+/).filter((l) => HOOK_RE.test(l)).map((url) => ({ id: HOOK_RE.exec(url)![1]!, url }));
if (!hooks.length) throw new Error("no webhook URLs in file");
const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

/** Runs in the page: upload `mb` MB, then each download setting; returns the transfer log and the placements to delete. */
const runSrc = async (D: never, hooks: { id: string; url: string }[], mb: number, up: string, down: string[], files: number, seed: number, drop: number[], build: string, lane: boolean) => {
  const DD = D as unknown as typeof import("@ddv4/metadata-client") & { Sequencer: new () => never };
  // The lane: the same protocol as the app's lane.html (one MessagePort; { id, url } → { id, st, ttfb, buf }).
  const lanes: ((url: string, init?: { signal?: AbortSignal }) => Promise<Response>)[] = [];
  let lanePort: MessagePort | null = null;
  if (lane) {
    const html = `<!doctype html><script>
      const ctl=new Map();let port=null;
      addEventListener('message',e=>{if(port||!e.data||e.data.ddnLane!==1||!e.ports[0])return;port=e.ports[0];port.onmessage=async m=>{const {id,url,abort}=m.data||{};
        if(abort)return void ctl.get(id)?.abort();const ac=new AbortController();ctl.set(id,ac);const t0=performance.now();
        try{const r=await fetch(url,{signal:ac.signal,credentials:'omit',cache:'no-store'});const ttfb=Math.round((performance.now()-t0)*10)/10;const buf=await r.arrayBuffer();port.postMessage({id,st:r.status,ttfb,buf},[buf])}
        catch(err){port.postMessage({id,err:String(err&&err.message||err).slice(0,120),aborted:ac.signal.aborted})}finally{ctl.delete(id)}}});
      parent.postMessage({ddnLaneReady:1},'*');<\/script>`;
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.display = "none";
    const ready = new Promise<void>((ok) =>
      addEventListener("message", (e) => {
        if (e.source !== f.contentWindow || !(e.data as { ddnLaneReady?: number })?.ddnLaneReady) return;
        const ch = new MessageChannel();
        f.contentWindow!.postMessage({ ddnLane: 1 }, "*", [ch.port1]);
        lanePort = ch.port2;
        ok();
      }),
    );
    f.srcdoc = html;
    document.body.append(f);
    await ready;
    let seq = 0;
    const wait = new Map<number, { ok: (r: Response) => void; err: (e: unknown) => void }>();
    lanePort!.onmessage = (e: MessageEvent<{ id: number; st?: number; ttfb?: number; buf?: ArrayBuffer; err?: string; aborted?: boolean }>) => {
      const w = wait.get(e.data?.id);
      if (!w) return;
      wait.delete(e.data.id);
      if (e.data.err !== undefined) return w.err(e.data.aborted ? Object.assign(new Error("aborted"), { name: "AbortError" }) : new TypeError(`lane: ${e.data.err}`));
      w.ok(new Response(e.data.buf ?? null, { status: e.data.st ?? 0, headers: { "x-ddn-ttfb": String(e.data.ttfb ?? 0) } }));
    };
    const call = (msg: Record<string, unknown>, signal?: AbortSignal) =>
      new Promise<Response>((ok, err) => {
        const id = ++seq;
        wait.set(id, { ok, err });
        signal?.addEventListener("abort", () => {
          if (!wait.has(id)) return;
          wait.delete(id);
          lanePort!.postMessage({ id, abort: true });
          err(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
        lanePort!.postMessage({ id, ...msg });
      });
    lanes.push((url, init) => call({ url }, init?.signal));
  }
  if (drop.length) {
    const real = globalThis.fetch.bind(globalThis);
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && /\/webhooks\//.test(String(input)) && drop.includes(++posts)) {
        await new Promise((r) => setTimeout(r, 300));
        throw new TypeError("Failed to fetch");
      }
      return real(input, init);
    }) as typeof fetch;
  }
  const size = Math.round(mb * 1e6);
  // Bytes computed from the seed and the offset (xorshift per 4-byte word): any range at any time, the same
  // bytes every run, nothing kept in memory or on disk. Not compressible enough to matter (encrypted anyway).
  const word = (i: number) => {
    let x = (i ^ seed ^ 0x9e3779b9) >>> 0;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    return (Math.imul(x >>> 0, 0x2545f491) ^ i) >>> 0;
  };
  const src = {
    size,
    read: async (o: number, l: number) => {
      const n = Math.max(0, Math.min(l, size - o));
      // Whole words (little-endian, like the byte order of word() below), then the requested bytes.
      const w0 = Math.floor(o / 4);
      const words = new Uint32Array(Math.ceil((o + n) / 4) - w0);
      for (let k = 0; k < words.length; k++) words[k] = word(w0 + k);
      return new Uint8Array(words.buffer, o - w0 * 4, n).slice();
    },
  };
  const mem = new DD.MemoryLogSink();
  const c = new DD.MetadataClient({
    device: { id: "bench", name: "bench" },
    arbiter: new DD.LocalArbiter(new DD.Sequencer()),
    transport: new DD.DiscordWebhookTransport(),
    webhooks: hooks,
  });
  c.setTransferLog(new DD.TransferLog(mem.write, { src: "web", mode: "metadata-only", build }));
  if (lanes.length) c.blobs.setCdnLanes?.(lanes);
  const placements: { hook: string; msg: string }[] = [];
  const out: { ups: { MBps: number; conc: number; err?: string }[]; up?: { MBps: number; conc: number; err?: string }; downs: { setting: string; MBps: number; err?: string }[] } = { ups: [], downs: [] };
  c.setConcurrency({ upload: up === "auto" ? null : Number(up) });
  // Earlier uploads of the same size first (`files` > 1): the automatic value learned there carries over,
  // like the next file in the app (the app also remembers it across sessions).
  for (let k = 1; k < files; k++) {
    const t1 = performance.now();
    try {
      const r = await c.upload(src, `warm-${k}.bin`);
      out.ups.push({ MBps: Math.round((size / 1e6 / ((performance.now() - t1) / 1000)) * 100) / 100, conc: c.uploadConcurrency });
      const { manifest } = await c.loadManifest(r.version.manifestRef);
      for (const ch of manifest.chunks) for (const p of ch.placements ?? []) placements.push({ hook: (p as { locationId: string }).locationId, msg: (p as { messageId: string }).messageId });
      const loc = DD.decodeManifestRef(r.version.manifestRef);
      placements.push({ hook: loc.at.locationId, msg: loc.at.messageId });
    } catch (e) {
      out.ups.push({ MBps: 0, conc: c.uploadConcurrency, err: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  let t = performance.now();
  let nodeId = "";
  try {
    const r = await c.upload(src, "bench.bin");
    nodeId = r.nodeId;
    out.up = { MBps: Math.round((size / 1e6 / ((performance.now() - t) / 1000)) * 100) / 100, conc: c.uploadConcurrency };
    const { manifest } = await c.loadManifest(r.version.manifestRef);
    for (const ch of manifest.chunks) for (const p of ch.placements ?? []) placements.push({ hook: (p as { locationId: string }).locationId, msg: (p as { messageId: string }).messageId });
    const loc = DD.decodeManifestRef(r.version.manifestRef);
    placements.push({ hook: loc.at.locationId, msg: loc.at.messageId });
  } catch (e) {
    out.up = { MBps: 0, conc: c.uploadConcurrency, err: String((e as Error)?.message ?? e).slice(0, 160) };
    return { out, log: mem.text(), placements };
  }
  for (const d of down) {
    c.setConcurrency({ download: d === "auto" ? null : Number(d) });
    await new Promise((r) => setTimeout(r, 5000)); // a pause between runs: separate busy periods in the log
    t = performance.now();
    let got = 0;
    try {
      await c.download(nodeId, { write: async (b: Uint8Array) => void (got += b.byteLength) });
      out.downs.push({ setting: d, MBps: Math.round((got / 1e6 / ((performance.now() - t) / 1000)) * 100) / 100 });
    } catch (e) {
      out.downs.push({ setting: d, MBps: 0, err: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  return { out, log: mem.text(), placements };
};

const entry = join(here, "..", "packages", "metadata-client", "live-bench-entry.tmp.ts");
writeFileSync(entry, `export * from "./src/index.js";\nexport { Sequencer } from "@ddv4/sync-core";\n`);
const bundle = await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "iife", globalName: "DDN", write: false, logLevel: "error" });
rmSync(entry);
const page = createServer((_q, r) => (r.writeHead(200, { "content-type": "text/html" }), r.end("<!doctype html><title>live bench</title>")));
await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
/** The line itself (speed.cloudflare.com, like scripts/conn-bench.mjs): MB/s each way, from this process. */
async function speedtest(dir: "down" | "up", streams = 8, seconds = 8): Promise<number> {
  const end = Date.now() + seconds * 1000;
  const t0 = Date.now();
  let bytes = 0;
  const chunk = new Uint8Array(25_000_000);
  await Promise.all(
    Array.from({ length: streams }, async () => {
      while (Date.now() < end) {
        try {
          if (dir === "down") {
            const r = await fetch("https://speed.cloudflare.com/__down?bytes=25000000", { signal: AbortSignal.timeout(Math.max(1000, end - Date.now())) });
            if (!r.ok || !r.body) break;
            for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
              bytes += c.length;
              if (Date.now() >= end) break;
            }
          } else {
            const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body: chunk, headers: { "content-type": "application/octet-stream" }, signal: AbortSignal.timeout(60_000) });
            await r.arrayBuffer();
            if (r.ok) bytes += chunk.length;
          }
        } catch {
          if (dir === "down") break;
        }
      }
    }),
  );
  return Math.round((bytes / 1e6 / ((Date.now() - t0) / 1000)) * 10) / 10;
}
let line: { downMBps: number; upMBps: number } | null = null;
if (SPEEDTEST) {
  line = { downMBps: await speedtest("down"), upMBps: await speedtest("up") };
  log(`line (speed.cloudflare.com, 8 streams): download ${line.downMBps} MB/s, upload ${line.upMBps} MB/s`);
}

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: BROWSER_ARGS });
const browserVersion = browser.version();
type Res = { out: unknown; log: string; placements: { hook: string; msg: string }[] };
const protoSeen: Record<string, Record<string, number>> = {};
let res = null as Res | null;
try {
  const p = await (await browser.newContext()).newPage();
  // Protocols of the responses (h3 = QUIC, h2, http/1.1), per host, for the page and the lane (an iframe
  // of the same page: its requests reach this session too, the lane by its frame).
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  const mainFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  cdp.on("Network.responseReceived", (e) => {
    let host = "?";
    try {
      host = new URL(e.response.url).host;
    } catch {
      /* keep ? */
    }
    if (!/discord(app)?\.(com|net)$/.test(host)) return;
    const k = `${e.frameId && e.frameId !== mainFrame ? "lane" : "page"} ${host}`;
    const pr = String(e.response.protocol ?? "?");
    (protoSeen[k] ??= {})[pr] = (protoSeen[k]![pr] ?? 0) + 1;
  });
  await p.goto(pageOrigin);
  await p.addScriptTag({ content: "window.__name = (f) => f;" });
  await p.addScriptTag({ content: bundle.outputFiles[0]!.text });
  log(`${LABEL}: ${MB} MB over ${hooks.length} channel(s), upload ${UP}, downloads ${DOWN.join(",")}; build ${BUILD}; browser ${browserVersion}${BROWSER_ARGS.length ? ` ${BROWSER_ARGS.join(" ")}` : ""}${LANE ? "; second connection (lane) on" : ""}`);
  res = (await p.evaluate(
    async ({ src, hooks, mb, up, down, files, seed, drop, build, lane }) => {
      const D = (globalThis as unknown as { DDN: never }).DDN;
      return (new Function(`return (${src})`)() as (...a: unknown[]) => Promise<unknown>)(D, hooks, mb, up, down, files, seed, drop, build, lane);
    },
    { src: runSrc.toString(), hooks, mb: MB, up: UP, down: DOWN, files: FILES, seed: SEED, drop: DROP, build: BUILD, lane: LANE },
  )) as Res;
} finally {
  await browser.close();
  page.close();
}
// Delete every posted message (test server), paced under the per-webhook limit.
const byId = new Map(hooks.map((h) => [h.id, h.url]));
let deleted = 0;
for (const pl of res?.placements ?? []) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${byId.get(pl.hook)}/messages/${pl.msg}`, { method: "DELETE" });
    if (r.status === 429) {
      const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((ok) => setTimeout(ok, Math.ceil((j.retry_after ?? 1) * 1000) + 50));
      continue;
    }
    if (r.ok || r.status === 404) deleted++;
    break;
  }
}
const rep = buildReport(parseLines(res?.log ?? "").events, { bucketS: 5 });
const summary = { label: LABEL, at: new Date().toISOString(), mb: MB, channels: hooks.length, build: BUILD, browser: browserVersion, browserArgs: BROWSER_ARGS, lane: LANE, line, protocols: protoSeen, result: res?.out, deleted, posted: res?.placements.length ?? 0, report: rep.summary };
log(JSON.stringify(res?.out));
log(`protocols: ${Object.entries(protoSeen).map(([k, v]) => `${k}: ${Object.entries(v).map(([p, n]) => `${p} ×${n}`).join(", ")}`).join("; ")}`);
log(`deleted ${deleted}/${res?.placements.length ?? 0} messages`);
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify(summary, null, 1) + "\n");
  writeFileSync(join(OUT, `${LABEL}.jsonl`), res?.log ?? "");
  writeFileSync(join(OUT, `${LABEL}.report.txt`), rep.text);
}
console.log(rep.text);
