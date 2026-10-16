// Browser ceiling of parallel 10 MiB POSTs over HTTP/2 vs HTTP/1.1: a local
// HTTPS+h2 server (like discord.com: one multiplexed connection) answering every POST after DELAY ms
// (the owner's log: ~3 s per 10 MiB post). Chromium allows 6 HTTP/1.1 connections per host.
//   DELAY=3000 npx tsx scripts/h2-vs-h1-posts.mts      (h2; scripts/concurrency-matrix.mts --proto h1 for h1)
import { chromium } from "playwright";
import { createSecureServer, constants } from "node:http2";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
const d = mkdtempSync(join(process.env.TMPDIR!, "h2-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k"), "-out", join(d, "c"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const buf = Buffer.alloc(10 * 1024 * 1024 + 28, 7);
const DELAY = Number(process.env.DELAY ?? 0);
const srv = createSecureServer({ key: readFileSync(join(d, "k")), cert: readFileSync(join(d, "c")), settings: { initialWindowSize: 32 << 20, maxConcurrentStreams: 1000 } });
srv.on("session", (s) => s.setLocalWindowSize?.(256 << 20));
srv.on("stream", (st, h) => {
  const path = String(h[":path"]);
  const method = String(h[":method"]);
  if (path === "/") { st.respond({ ":status": 200, "content-type": "text/html" }); return void st.end("<!doctype html>x"); }
  if (method === "POST") {
    let n = 0; st.on("data", (c) => (n += c.length));
    st.on("end", () => setTimeout(() => { st.respond({ ":status": 200, "content-type": "text/plain" }); st.end(String(n)); }, DELAY));
    return;
  }
  setTimeout(() => { st.respond({ ":status": 200, "content-type": "application/octet-stream", "content-length": buf.length }); st.end(buf); }, DELAY);
});
srv.on("sessionError", (e) => console.log("sessionError", String(e)));
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `https://127.0.0.1:${(srv.address() as { port: number }).port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--ignore-certificate-errors"] });
const p = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
await p.goto(base + "/");
console.log("protocol", await p.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).nextHopProtocol));
for (const [kind, conc] of [["POST", 3], ["POST", 8], ["POST", 16], ["POST", 30], ["POST", 60]] as const) {
  const r = await p.evaluate(`(async () => { let ok = 0, fail = 0, err = ""; const t = performance.now(); const data = new Uint8Array(10 * 1024 * 1024 + 28);
    await Promise.all(Array.from({ length: ${conc} }, async () => { for (let i = 0; i < 3; i++) { try {
      const r = ${kind === "GET" ? `await fetch("/x?" + Math.random())` : `await fetch("/up?" + Math.random(), { method: "POST", body: (() => { const f = new FormData(); f.append("files[0]", new Blob([data]), "a"); return f; })() })`};
      await r.arrayBuffer(); ok++; } catch (e) { fail++; err = String(e); } } }));
    return { ok, fail, err, MBps: Math.round(ok * 10.5 / ((performance.now() - t) / 1000) * 10) / 10 }; })()`);
  console.log("delay", DELAY, kind, "conc", conc, JSON.stringify(r));
}
await b.close(); srv.close();
