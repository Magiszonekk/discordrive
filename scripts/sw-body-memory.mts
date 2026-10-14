// Diagnosis (2026-10-14): upload bodies of a client controlled by a service worker stay in Chromium's
// browser process. Variants: body kind × worker kind × profile. Prints one line per variant.
import { chromium, type BrowserContext } from "playwright";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sink = createServer((req, res) => {
  const h = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
  if (req.method === "OPTIONS") return void (res.writeHead(204, h), res.end());
  let n = 0;
  req.on("data", (c) => (n += c.length));
  req.on("end", () => (res.writeHead(200, { ...h, "content-type": "text/plain" }), res.end(String(n))));
});
await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(sink.address() as { port: number }).port}/up`;

const bodyCode: Record<string, string> = {
  formdata: `const fd = new FormData(); fd.append("files[0]", new Blob([d]), "a.txt"); body = fd;`,
  blobparts: `body = new Blob([new TextEncoder().encode("--b\\r\\n\\r\\n"), d, new TextEncoder().encode("\\r\\n--b--\\r\\n")]);`,
};
const worker = (kind: string) => `self.onmessage = async (e) => {
  const { url, total } = e.data; let next = 0; const t = performance.now(); let fail = 0, err = "";
  const one = async () => { for (;;) { const i = next++; if (i >= total) return;
    const d = new Uint8Array(10 * 1024 * 1024 + 28); crypto.getRandomValues(d.subarray(0, 4096));
    let body; ${bodyCode[kind]}
    try { const r = await fetch(url, { method: "POST", body }); await r.text(); } catch (x) { fail++; err = String(x); }
  } };
  await Promise.all(Array.from({ length: 8 }, one));
  postMessage({ done: true, fail, err, MBps: Math.round(total * 10.5 / ((performance.now() - t) / 1000)) }); };`;
const sw = `self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname.startsWith("/ddn/")) e.respondWith(new Response("x")); });`;
const page = createServer((q, r) => {
  if (q.url === "/w/sw-empty.js") return void (r.writeHead(200, { "content-type": "text/javascript" }), r.end(`self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));`));
  const m = /^(?:\/w)?\/w-(\w+)\.js$/.exec(q.url ?? "");
  if (m) return void (r.writeHead(200, { "content-type": "text/javascript" }), r.end(worker(m[1]!)));
  if (q.url === "/sw.js") return void (r.writeHead(200, { "content-type": "text/javascript" }), r.end(sw));
  r.writeHead(200, { "content-type": "text/html" });
  r.end("<!doctype html>x");
});
await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const browserRss = () =>
  Math.round(
    execSync("ps -e -o rss=,args=", { encoding: "utf8" })
      .split("\n")
      .filter((l) => /chrome-headless/.test(l) && !/--type=/.test(l))
      .reduce((s, l) => s + Number(l.trim().split(/\s+/)[0]), 0) / 1024,
  );

for (const v of process.argv.slice(2)) {
  // <body>:<worker url|blob>:<sw|nosw>:<incognito|persistent>
  const [kind, wk, swOn, prof] = v.split(":") as [string, string, string, string];
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-prof-"));
  const exe = { executablePath: process.env.CHROMIUM_PATH };
  const b = prof === "persistent" ? null : await chromium.launch(exe);
  const ctx: BrowserContext = prof === "persistent" ? await chromium.launchPersistentContext(dir, exe) : await b!.newContext();
  try {
    const p = await ctx.newPage();
    await p.goto(base + "/");
    if (wk === "sub") {
      // A second registration for /w/ whose worker has no fetch handler: the app worker under /w/ is its client.
      await p.evaluate(`navigator.serviceWorker.register("/w/sw-empty.js", { scope: "/w/" }).then(async (r) => { const w = r.installing || r.waiting || r.active; if (w && w.state !== "activated") await new Promise((ok) => w.addEventListener("statechange", () => w.state === "activated" && ok())); })`);
    }
    if (swOn === "sw") {
      await p.evaluate(`navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready)`);
      await p.reload();
      await p.waitForFunction("!!navigator.serviceWorker.controller");
    }
    const rss0 = browserRss();
    let peak = rss0;
    const tm = setInterval(() => void (peak = Math.max(peak, browserRss())), 500);
    const mk = wk === "sub" ? `new Worker("/w/w-${kind}.js")` : wk === "blob" ? `new Worker(URL.createObjectURL(new Blob([await (await fetch("/w-${kind}.js")).text()], { type: "text/javascript" })))` : `new Worker("/w-${kind}.js")`;
    const r = await p.evaluate(`(async () => { const w = ${mk}; return await new Promise((ok) => { w.onmessage = (e) => { if (e.data.done) ok(e.data); }; w.postMessage({ url: ${JSON.stringify(url)}, total: 300 }); }); })()`);
    clearInterval(tm);
    await new Promise((x) => setTimeout(x, 3000));
    console.log(JSON.stringify({ v, ...(r as object), browserRssMB: { before: rss0, peak, after3s: browserRss() } }));
  } catch (e) {
    console.log(JSON.stringify({ v, error: String(e).slice(0, 200) }));
  } finally {
    await ctx.close();
    await b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
page.close();
sink.close();
