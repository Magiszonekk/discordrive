// Tree layer in the browser: SQLite-WASM on OPFS (SAH pool) in a
// dedicated Worker in headless Chromium. Replays random stage-1 logs there and
// compares the canonical state hashes with Node (MemoryIndexStore), then checks
// that the database survives a page reload.
// Usage: CHROMIUM_PATH=... npx tsx test/browser/opfs-check.ts [cases=30] [seed=11]
import fc from "fast-check";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalState, replay, type LogEntry } from "@ddv4/sync-core";
import { actionArb as simArb, lastLog, newStats, runCase, type Action } from "../../../sync-core/test/sim.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = Number(process.argv[2] ?? 30);
const seed = Number(process.argv[3] ?? 11);
const actionArb = simArb as unknown as fc.Arbitrary<Action>;

const worker = (
  await build({ entryPoints: [join(here, "opfs-worker.ts")], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "error" })
).outputFiles[0]!.text;
const wasmPath = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
const wasm = readFileSync(wasmPath);

const logs: LogEntry[][] = [];
const stats = newStats();
for (const actions of fc.sample(fc.array(actionArb, { minLength: 30, maxLength: 250, size: "max" }), { seed, numRuns: cases })) {
  runCase(actions, stats);
  logs.push(lastLog()!);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const nodeHashes = logs.map((l) => sha(canonicalState(replay(l).store)));

// OPFS needs a secure context: http://127.0.0.1 counts as one.
const srv = createServer((q, r) => {
  if (q.url === "/w.js") return r.writeHead(200, { "content-type": "text/javascript" }), r.end(worker);
  if (q.url?.startsWith("/sqlite3.wasm")) return r.writeHead(200, { "content-type": "application/wasm" }), r.end(wasm);
  r.writeHead(200, { "content-type": "text/html" });
  r.end("<!doctype html><title>opfs</title>");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = true;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(origin);
  const call = (msg: unknown) =>
    page.evaluate(
      (m) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const w = new Worker("/w.js", { type: "module" });
          w.onmessage = (e) => (w.terminate(), resolve(e.data));
          w.onerror = (e) => resolve({ ok: false, error: e.message });
          w.postMessage(m);
        }),
      msg,
    );
  const wasmUrl = `${origin}/sqlite3.wasm`;
  const t0 = Date.now();
  const r = await call({ cmd: "replay", logs, wasmUrl });
  if (!r.ok) throw new Error(String(r.error));
  const browserHashes = r.hashes as string[];
  const mismatches = browserHashes.filter((h, i) => h !== nodeHashes[i]!.slice(0, 16)).length;
  const replayMs = Date.now() - t0;

  const w = await call({ cmd: "persist-write", logs: [logs[0]], wasmUrl });
  await page.reload();
  const rd = await call({ cmd: "persist-read", wasmUrl });
  const persisted = rd.ok === true && rd.hash === w.hash && rd.head === logs[0]!.length;

  const entries = logs.reduce((n, l) => n + l.length, 0);
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log(JSON.stringify({ engine: ua.replace(/^.*(HeadlessChrome\/[\d.]+).*$/, "$1"), store: "sqlite-wasm/opfs-sahpool", cases, entries, mismatches, persistedAcrossReload: persisted, replayMs, workerOpenMs: r.openMs, workerApplyMs: r.applyMs, applyMsPerEntry: Math.round(((r.applyMs as number) / entries) * 100) / 100 }));
  failed = mismatches > 0 || !persisted;
} finally {
  await browser.close();
  srv.close();
}
process.exit(failed ? 1 : 0);
