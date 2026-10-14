// Download of a big file straight to disk (zlecenie 2026-10-13-transfer §3): a synthetic ≥ 4 GB file on
// the fake Discord (fragments kept on disk), uploaded and downloaded through the real web app in
// headless Chromium (metadata-only build, service worker stream), SHA-256 compared, memory of the
// browser's processes sampled during the download (the tab used to collect the whole file in a Blob).
//   npx tsx scripts/bigfile-download-check.mts [--gb 4.2] [--out result.json]
// Disk: ~3 × the size in $TMPDIR (source, fake Discord, the downloaded file); all removed at the end.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { createReadStream, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DdnServer, DISCORD_ORIGINS, FakeDiscord } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const GB = Number(arg("gb", "4.2"));
const OUT = arg("out", "");
// --blob: force the old path (whole file in a Blob in the tab) for comparison.
const BLOB = process.argv.includes("--blob");
// --force-gc (diagnosis): run gc() in the page's workers every second (Chromium started with --expose-gc).
const FORCE_GC = process.argv.includes("--force-gc");
// --no-sw (diagnosis): the context blocks service workers (uploads are not routed through one).
const NO_SW = process.argv.includes("--no-sw");
const size = Math.round(GB * 1e9);
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-big-"));
const r1 = (x: number) => Math.round(x * 10) / 10;

const sha = (f: string) =>
  new Promise<string>((ok, bad) => {
    const h = createHash("sha256");
    createReadStream(f, { highWaterMark: 8 << 20 }).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", bad);
  });

/** RSS (MB) per Chromium process type (browser / renderer / gpu / utility). */
function rssByType(): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = execSync("ps -e -o pid=,ppid=,rss=,args=", { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/));
  const kids = new Set<number>([process.pid]);
  for (let ch = true; ch; ) {
    ch = false;
    for (const r of rows) if (kids.has(Number(r[1])) && !kids.has(Number(r[0]))) ((kids.add(Number(r[0]))), (ch = true));
  }
  for (const r of rows) {
    if (!kids.has(Number(r[0])) || !/chrome/.test(r[3] ?? "")) continue;
    const ty = /--type=([\w-]+)/.exec(r.slice(3).join(" "))?.[1] ?? "browser";
    const util = /--utility-sub-type=([\w.]+)/.exec(r.slice(3).join(" "))?.[1];
    const k = util ? `${ty}:${util.split(".").pop()}` : ty;
    out[k] = Math.round((out[k] ?? 0) + Number(r[2]) / 1024);
  }
  return out;
}

/** RSS (MB) of every process under this one (the browser and its renderers / GPU / utility processes). */
function treeRss(): { total: number; max: number; n: number } {
  const rows = execSync("ps -e -o pid=,ppid=,rss=,comm=", { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, rss, comm]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss) / 1024, comm }));
  const kids = new Set<number>([process.pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) ((kids.add(r.pid)), (changed = true));
  }
  const mine = rows.filter((r) => kids.has(r.pid) && r.pid !== process.pid && /chrome/i.test(r.comm ?? ""));
  return { total: r1(mine.reduce((s, r) => s + r.rss, 0)), max: r1(Math.max(0, ...mine.map((r) => r.rss))), n: mine.length };
}

const res: Record<string, unknown> = { at: new Date().toISOString(), sizeBytes: size, path: BLOB ? "blob" : "stream" };
const src = join(work, "big.bin");
const t0 = Date.now();
execFileSync("bash", ["-c", `head -c ${size} /dev/urandom > ${src}`]);
res.makeSourceS = r1((Date.now() - t0) / 1000);
const srcSha = await sha(src);

const fake = new FakeDiscord();
fake.blobDir = join(work, "fake");
mkdirSync(fake.blobDir);
const origin = await fake.listen();
// 8 channels: the app's own pacer (30 posts/min per channel, like Discord) lets ~40 MB/s through, so
// the 4 GB upload takes minutes, not a quarter of an hour.
const hooks = Array.from({ length: Number(arg("channels", "8")) }, (_, i) => fake.addWebhook(String(1550000000000008001n + BigInt(i))));
const dist = join(work, "dist");
execFileSync(process.execPath, [join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "..", "apps", "web-mo", "build.ts"), "metadata-only", dist], { stdio: "ignore" });
const srv = new DdnServer({ signup: "invite", rateLimits: false, mode: "metadata-only", web: { dir: join(dist, "metadata-only"), connectSrc: [...DISCORD_ORIGINS, origin], config: { discordApiOrigin: origin, mode: "metadata-only", ...(BLOB ? { streamMinBytes: 1e15 } : {}) } } });
const base = (await srv.listen(0)).url;
const invite = srv.invites.create().code;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), ...(FORCE_GC ? { args: ["--js-flags=--expose-gc"] } : {}) });
let ok = false;
try {
  const ctx = await browser.newContext({ acceptDownloads: true, ...(NO_SW ? { serviceWorkers: "block" as const } : {}) });
  await ctx.addInitScript({ content: "window.__name = (f) => f;" });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => (m.type() === "error" || m.type() === "warning" ? console.error(`[page ${m.type()}] ${m.text()}`) : undefined));
  p.on("crash", () => console.error("[page crashed]"));
  await p.goto(base);
  await p.waitForSelector("body[data-ready='1']");
  // Account + two channels through the core (the UI flow is covered by check.ts), then the files page.
  await p.evaluate(
    async ({ base, invite, hooks }) => {
      const core = (window as unknown as { ddnCore: Record<string, (...a: unknown[]) => Promise<unknown>> }).ddnCore;
      await core.createAccount!(base, "big", invite);
      await core.open!();
      for (const h of hooks) await core.addWebhook!(h);
      await core.confirmKitSaved!();
    },
    { base, invite, hooks: hooks.map((h) => h.url) },
  );
  await p.goto(base);
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForSelector("[data-ddn=file]", { state: "attached" });
  const upSamples: number[] = [];
  let upTick = 0;
  const gcTimer = FORCE_GC ? setInterval(() => void Promise.all(p.workers().map((w) => w.evaluate("self.gc && self.gc()").catch(() => {}))), 1000) : null;
  const upTimer = setInterval(() => {
    upSamples.push(treeRss().total);
    if (++upTick % 10 === 0) console.error(`[up +${upTick} s] ${JSON.stringify(rssByType())}`);
  }, 1000);
  const rssStart = treeRss();
  let t = Date.now();
  await p.setInputFiles("[data-ddn=file]", src);
  await p.waitForSelector("[data-ddn=row]", { timeout: 1800_000 });
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === "Uploaded", null, { timeout: 1800_000 });
  res.uploadS = r1((Date.now() - t) / 1000);
  res.uploadMBps = r1(size / 1e6 / ((Date.now() - t) / 1000));
  res.uploadQueueText = await p.textContent("[data-ddn=queue-meta]");
  clearInterval(upTimer);
  if (gcTimer) clearInterval(gcTimer);
  res.uploadMemMB = { start: rssStart.total, peak: Math.max(...upSamples), end: treeRss().total, heapMB: await p.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6)) };
  console.error(`[upload mem] ${JSON.stringify(res.uploadMemMB)} ${JSON.stringify(rssByType())}`);
  await new Promise((r) => setTimeout(r, 20_000));
  res.uploadMemAfter20s = rssByType();
  console.error(`[upload mem +20 s] ${JSON.stringify(res.uploadMemAfter20s)}`);
  // Download: memory sampled every 500 ms until the browser has the whole file.
  const samples: { t: number; total: number; max: number }[] = [];
  const base0 = treeRss();
  const timer = setInterval(() => {
    const m = treeRss();
    samples.push({ t: Date.now(), total: m.total, max: m.max });
    if (samples.length % 20 === 0) console.error(`[down +${samples.length / 2} s] ${JSON.stringify(rssByType())}`);
  }, 500);
  // The panel closes itself 6 s after a success (and empties its list): record the end state when it is set.
  await p.evaluate(() => {
    const w = window as unknown as { __dl?: { state: string; speed: string | null; title: string | null } };
    new MutationObserver(() => {
      const li = document.querySelector<HTMLElement>("[data-ddn=dl-item][data-state]");
      if (li && !w.__dl) w.__dl = { state: li.dataset.state!, speed: li.querySelector("[data-ddn=dl-speed]")?.textContent ?? null, title: li.querySelector(".qstate")?.getAttribute("title") ?? null };
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });
  t = Date.now();
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), p.locator("[data-ddn=row]").first().locator("[data-ddn=download]").click()]);
  const out = join(work, "downloaded.bin");
  await dl.saveAs(out);
  console.error(`[saved ${((Date.now() - t) / 1000).toFixed(1)} s]`);
  await p.waitForFunction(() => !!(window as unknown as { __dl?: unknown }).__dl, null, { timeout: 600_000 });
  res.downloadState = await p.evaluate(() => (window as unknown as { __dl: unknown }).__dl);
  clearInterval(timer);
  res.downloadMemByType = rssByType();
  console.error(`[download mem by type] ${JSON.stringify(res.downloadMemByType)}`);
  console.error(`[download mem] peak ${Math.max(...samples.map((x) => x.total))} MB, last ${samples.at(-1)?.total} MB`);
  res.downloadS = r1((Date.now() - t) / 1000);
  res.downloadMBps = r1(size / 1e6 / ((Date.now() - t) / 1000));
  res.downloadPanel = (res.downloadState as { speed: string | null }).speed;
  res.streamed = (await p.$$eval("[data-ddn=dl-frame]", (e) => e.length)) > 0;
  res.memMB = { before: base0, peakTotal: Math.max(...samples.map((s) => s.total)), peakProcess: Math.max(...samples.map((s) => s.max)), samples: samples.length };
  res.sizeOk = statSync(out).size === size;
  res.sha256Ok = (await sha(out)) === srcSha;
  res.pageErrors = errors;
  ok = (res.downloadState as { state: string }).state === "done" && res.sizeOk === true && res.sha256Ok === true && res.streamed === !BLOB && errors.length === 0;
} finally {
  await browser.close();
  await srv.close();
  await fake.close();
  rmSync(work, { recursive: true, force: true });
}
res.ok = ok;
console.log(JSON.stringify(res, null, 1));
if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
process.exit(ok ? 0 : 1);
