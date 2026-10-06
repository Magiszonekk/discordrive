// End-to-end check of the browser app (headless Chromium): built dist/ served
// on 127.0.0.1, real metadata-only server (Ed25519 sign-in), fake Discord over
// HTTP (no network). Drives the UI through data-ddn hooks.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "build.ts")], { stdio: "ignore" });
const dist = join(here, "dist");

const fake = new FakeDiscord();
const discordOrigin = await fake.listen();
const hook = fake.addWebhook("chan-web");

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const web = createServer((q, r) => {
  const path = new URL(q.url ?? "/", "http://x").pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  try {
    let body = readFileSync(join(dist, file));
    if (file === "index.html") {
      body = Buffer.from(String(body).replace("<script", `<script>window.DDN_CONFIG=${JSON.stringify({ discordApiOrigin: discordOrigin, serverUrl: apiUrl })}</script><script`));
    }
    r.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    r.end(body);
  } catch {
    r.writeHead(404);
    r.end();
  }
});
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const webOrigin = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
const srv = new DdnServer({ corsOrigins: [webOrigin] });
const { url: apiUrl } = await srv.listen(0);

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-web-"));
const video = join(dir, "klip.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8", "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8", video]);
const doc = join(dir, "notatki.txt");
writeFileSync(doc, "Zażółć gęślą jaźń\n".repeat(1000));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = false;
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "window.__name = (f) => f;" }); // tsx wraps named fns passed to evaluate()
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(webOrigin);
  await p.waitForSelector("body[data-ready='1']");
  await p.fill("[data-ddn=device-name]", "Chromium");
  await p.click("[data-ddn=create]");
  await p.waitForSelector("[data-ddn=signed-in]:not([hidden])");
  await p.fill("[data-ddn=webhook-url]", hook.url);
  await p.click("[data-ddn=add-webhook]");
  await p.waitForFunction(() => document.querySelector("[data-ddn=advice]")?.textContent?.includes("3–4"));
  await p.fill("[data-ddn=folder-name]", "Wakacje");
  await p.click("[data-ddn=mkdir]");
  await p.setInputFiles("[data-ddn=file]", [doc, video]);
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=row]").length === 3, null, { timeout: 30_000 });
  const rows = await p.$$eval("[data-ddn=row]", (els) => els.map((e) => e.textContent ?? ""));
  const status = await p.textContent("[data-ddn=status]");

  // download notatki.txt through the app and compare
  const dl = await p.evaluate(async () => {
    const core = (window as unknown as { ddnCore: { list(p?: string): Promise<{ rows: { id: string; name: string }[] }>; download(id: string): Promise<Blob> } }).ddnCore;
    const rows = (await core.list()).rows;
    const id = rows.find((r) => r.name === "notatki.txt")!.id;
    return await (await core.download(id)).text();
  });
  const downloadOk = dl === readFileSync(doc, "utf8");

  // play the video through the service worker (Range -> page -> app worker -> CDN)
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForSelector("[data-ddn=row]");
  const playRow = p.locator("[data-ddn=row]", { hasText: "klip.webm" });
  await playRow.locator("[data-ddn=play]").click();
  const vid = await p.evaluate(
    () =>
      new Promise<{ duration: number; t: number; err: string | null }>((resolve) => {
        const v = document.querySelector<HTMLVideoElement>("[data-ddn=player]")!;
        const done = () => resolve({ duration: v.duration, t: v.currentTime, err: v.error?.message ?? null });
        v.addEventListener("error", done, { once: true });
        v.addEventListener("timeupdate", () => v.currentTime > 0.2 && done());
        setTimeout(done, 15_000);
      }),
  );

  // a second tab: not the main tab, still sees the files (in-memory replica)
  const p2 = await ctx.newPage();
  await p2.goto(webOrigin);
  await p2.waitForSelector("body[data-ready='1']");
  await p2.waitForSelector("[data-ddn=row]");
  const status2 = await p2.textContent("[data-ddn=status]");
  const rows2 = await p2.$$eval("[data-ddn=row]", (els) => els.length);

  // live update: a folder made in tab 2 appears in tab 1 (websocket push)
  await p2.fill("[data-ddn=folder-name]", "Z drugiej karty");
  await p2.click("[data-ddn=mkdir]");
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=row]")].some((e) => e.textContent?.includes("Z drugiej karty")), null, { timeout: 10_000 });

  const r = {
    rows,
    mainTab: status?.includes("karta główna") ?? false,
    secondTabIsSecondary: status2?.includes("karta pomocnicza") ?? false,
    secondTabRows: rows2,
    downloadOk,
    video: vid,
    discordPosts: fake.posts,
    pageErrors: errors,
  };
  console.log(JSON.stringify(r));
  ok =
    rows.length === 3 &&
    r.mainTab &&
    r.secondTabIsSecondary &&
    rows2 === 3 &&
    downloadOk &&
    !vid.err &&
    vid.duration > 7 &&
    vid.t > 0.2 &&
    errors.length === 0;
} finally {
  await browser.close();
  web.close();
  await srv.close();
  await fake.close();
}
process.exit(ok ? 0 : 1);
