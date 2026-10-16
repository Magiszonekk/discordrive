// Cross-engine determinism check: replay the same random logs
// in Node and in a real browser engine (headless Chromium via Playwright) and
// compare the canonical states byte for byte.
//
// Usage: npx tsx test/browser-check.ts [cases=30] [seed=7]
// Needs Playwright's Chromium (npx playwright install chromium).

import fc from "fast-check";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalState, initIndex, applyEntry, MemoryIndexStore, type LogEntry } from "../src/index.js";
import { actionArb, newStats, runCase, lastLog } from "./sim.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = Number(process.argv[2] ?? 30);
const seed = Number(process.argv[3] ?? 7);

const bundle = await build({
  entryPoints: [join(here, "..", "src", "index.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "SyncCore",
  write: false,
});
const code = bundle.outputFiles[0]!.text;

const logs: LogEntry[][] = [];
const stats = newStats();
for (const actions of fc.sample(fc.array(actionArb, { minLength: 30, maxLength: 300, size: "max" }), { seed, numRuns: cases })) {
  runCase(actions, stats);
  logs.push(lastLog()!);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const nodeHashes = logs.map((log) => {
  const st = initIndex(new MemoryIndexStore());
  for (const e of log) applyEntry(st, e);
  return sha(canonicalState(st));
});

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: code });
  const states: string[] = await page.evaluate((logs) => {
    const S = (globalThis as unknown as { SyncCore: typeof import("../src/index.js") }).SyncCore;
    return logs.map((log) => {
      const st = S.initIndex(new S.MemoryIndexStore());
      for (const e of log) S.applyEntry(st, e);
      return S.canonicalState(st);
    });
  }, logs);
  const ua = await page.evaluate(() => navigator.userAgent);
  const browserHashes = states.map(sha);
  const mismatches = browserHashes.filter((h, i) => h !== nodeHashes[i]).length;
  const entries = logs.reduce((n, l) => n + l.length, 0);
  console.log(JSON.stringify({ engine: ua, cases, entries, mismatches, sample: nodeHashes.slice(0, 3) }));
  if (mismatches > 0) process.exit(1);
} finally {
  await browser.close();
}
