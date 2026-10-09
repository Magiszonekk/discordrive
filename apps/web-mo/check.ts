// End-to-end check of the browser app (headless Chromium) against the real
// instance server (`discordrive serve` code path: API + web app on ONE origin,
// invite-only sign-up, share bot) and a fake Discord over HTTP (no network).
// Drives the UI through data-ddn hooks.
//
// Against a deployed instance: DDN_E2E_URL=https://… DDN_E2E_INVITE=ddn-inv-…
// DDN_E2E_WEBHOOK_FILES=a.url:b.url (Discord is real then). DDN_E2E_SHOTS=dir
// saves screenshots.
import { chromium, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DdnServer, DISCORD_ORIGINS, FakeDiscord, type BotRefresher } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "build.ts")], { stdio: "ignore" });
const dist = join(here, "dist");
const remote = process.env.DDN_E2E_URL?.replace(/\/$/, "");
const shotDir = process.env.DDN_E2E_SHOTS;
if (shotDir) mkdirSync(shotDir, { recursive: true });

let fake: FakeDiscord | null = null;
let srv: DdnServer | null = null;
let base: string;
let invite: string;
let hookUrls: string[];
if (remote) {
  base = remote;
  invite = process.env.DDN_E2E_INVITE ?? "";
  hookUrls = (process.env.DDN_E2E_WEBHOOK_FILES ?? "").split(":").filter(Boolean).map((f) => readFileSync(f, "utf8").trim());
  if (!invite || !hookUrls.length) throw new Error("DDN_E2E_INVITE and DDN_E2E_WEBHOOK_FILES are required with DDN_E2E_URL");
} else {
  fake = new FakeDiscord();
  const discordOrigin = await fake.listen();
  fake.botToken = "fake-bot";
  const refresher: BotRefresher = {
    async refresh(urls) {
      const r = await fetch(`${discordOrigin}/api/v10/attachments/refresh-urls`, {
        method: "POST",
        headers: { authorization: "Bot fake-bot", "content-type": "application/json" },
        body: JSON.stringify({ attachment_urls: urls }),
      });
      const j = (await r.json()) as { refreshed_urls: { original: string; refreshed: string }[] };
      return j.refreshed_urls.map((x) => x.refreshed);
    },
  };
  hookUrls = [fake.addWebhook("1550000000000000101").url, fake.addWebhook("1550000000000000102").url];
  const s = new DdnServer({
    signup: "invite",
    rateLimits: false,
    web: { dir: dist, connectSrc: [...DISCORD_ORIGINS, discordOrigin], config: { discordApiOrigin: discordOrigin } },
    bot: refresher,
    cdnOrigins: [discordOrigin],
  });
  srv = s;
  base = (await s.listen(0)).url;
  invite = s.invites.create().code;
}

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-web-"));
const video = join(dir, "klip.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8", "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8", video]);
const doc = join(dir, "notatki.txt");
writeFileSync(doc, "Zażółć gęślą jaźń\n".repeat(1000));
// Bigger than one fragment (10 MiB) so the progress has several steps.
const big = join(dir, "duzy.bin");
writeFileSync(big, (await import("node:crypto")).randomBytes(12 * 1024 * 1024));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors: string[] = [];
async function newPage(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && console.error("console:", m.text().slice(0, 300)));
  return p;
}
const shot = async (p: Page, name: string) => void (shotDir && (await p.screenshot({ path: join(shotDir, `${name}.png`) })));
const t0 = Date.now();
const step = (s: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const count = (p: Page, re: RegExp) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-ddn=count]")?.textContent ?? ""), re.source, { timeout: 30_000 });

let ok = false;
const r: Record<string, unknown> = { base };
try {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript({ content: "window.__name = (f) => f;" }); // tsx wraps named fns passed to evaluate()
  const p = await newPage(ctx);
  await p.goto(base);
  await p.waitForSelector("body[data-ready='1']");
  r.serverFieldHidden = await p.isHidden("[data-ddn-ui=server-field]");
  r.inviteFieldShown = await p.isVisible("[data-ddn=invite]");
  await shot(p, "01-welcome");

  // 1. sign-up: without a code refused, with the code OK
  step("sign-up");
  await p.fill("[data-ddn=device-name]", "Laptop testowy");
  await p.click("[data-ddn=create]");
  await p.waitForSelector(".toast.err");
  r.signupWithoutInviteRefused = (await p.textContent(".toast.err"))?.includes("invite_required") ?? false;
  await p.fill("[data-ddn=invite]", invite);
  await p.click("[data-ddn=create]");
  await p.waitForSelector("[data-ddn=signed-in]:not([hidden])");
  r.mainTab = (await p.textContent("[data-ddn=status]"))?.includes("karta główna") ?? false;

  // 2. channel wizard; the rescue kit is forced right after the first channel
  step("channels");
  await shot(p, "02-wizard");
  await p.fill("[data-ddn=webhook-url]", hookUrls[0]!);
  await p.click("[data-ddn=add-webhook]");
  await p.waitForSelector("[data-ddn=kit-dialog][open]", { timeout: 30_000 });
  await p.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("[data-ddn=kit-text]")?.value ?? "").length > 20);
  const kit = await p.inputValue("[data-ddn=kit-text]");
  r.kitFormat = kit.startsWith("ddn-kit1:");
  r.kitQr = (await p.$$eval("[data-ddn=kit-qr] svg", (e) => e.length)) === 1;
  r.kitDoneDisabledBeforeAck = await p.isDisabled("[data-ddn=kit-done]");
  await p.keyboard.press("Escape");
  r.kitNotDismissableByEsc = await p.isVisible("[data-ddn=kit-dialog][open]");
  const [kitFile] = await Promise.all([p.waitForEvent("download"), p.click("[data-ddn=kit-download]")]);
  r.kitFileHasCode = readFileSync((await kitFile.path())!, "utf8").includes(kit);
  await shot(p, "03-rescue-kit");
  await p.check("[data-ddn=kit-ack]");
  await p.click("[data-ddn=kit-done]");
  await p.waitForSelector("[data-ddn=kit-dialog][open]", { state: "detached" });
  if (hookUrls[1]) {
    await p.fill("[data-ddn=webhook-url]", hookUrls[1]);
    await p.click("[data-ddn=add-webhook]");
    await p.waitForFunction(() => document.querySelector("[data-ddn-ui=hook-count]")?.textContent?.startsWith("2"), null, { timeout: 30_000 });
  }
  r.advice = await p.textContent("[data-ddn=advice]");

  // 3. upload with byte progress
  step("upload");
  await p.fill("[data-ddn=folder-name]", "Wakacje");
  await p.click("[data-ddn=mkdir]");
  await count(p, /^1 pozycja$/);
  const progress: string[] = [];
  await p.exposeFunction("__progress", (s: string) => void progress.push(s));
  await p.evaluate(() => {
    const q = document.querySelector("[data-ddn-ui=queue-list]")!;
    new MutationObserver(() => {
      for (const li of q.querySelectorAll("[data-ddn=queue-item]")) (window as unknown as { __progress(s: string): void }).__progress(`${li.firstElementChild?.textContent}:${li.querySelector(".qstate")?.textContent}`);
    }).observe(q, { childList: true, characterData: true, subtree: true });
  });
  await p.setInputFiles("[data-ddn=file]", [doc, video, big]);
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === "Wysłano", null, { timeout: 300_000 });
  await count(p, /^4 pozycji$/);
  const bigSteps = [...new Set(progress.filter((x) => x.startsWith("duzy.bin:") && /%$/.test(x)))];
  r.progressBigFile = bigSteps;
  await shot(p, "04-uploaded");

  // 4. download through the UI and compare SHA-256
  step("download");
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), p.locator("[data-ddn=row]", { hasText: "duzy.bin" }).locator("[data-ddn=download]").click()]);
  r.downloadSha256Ok = sha(readFileSync((await dl.path())!)) === sha(readFileSync(big));
  r.downloadName = dl.suggestedFilename();

  // 5. video through the service worker (Range), with a seek
  step("video");
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForSelector("[data-ddn=row]");
  await p.locator("[data-ddn=row]", { hasText: "klip.webm" }).locator("[data-ddn=play]").click();
  r.video = await p.evaluate(
    () =>
      new Promise<{ duration: number; t: number; err: string | null; seeked: boolean }>((resolve) => {
        const v = document.querySelector<HTMLVideoElement>("[data-ddn=player]")!;
        let seeked = false;
        const done = () => resolve({ duration: v.duration, t: v.currentTime, err: v.error?.message ?? null, seeked });
        v.addEventListener("error", done, { once: true });
        v.addEventListener("seeked", () => ((seeked = true), setTimeout(done, 300)), { once: true });
        const tu = () => {
          if (v.currentTime > 0.2 && !seeked) {
            v.removeEventListener("timeupdate", tu);
            v.currentTime = 6;
          }
        };
        v.addEventListener("timeupdate", tu);
        setTimeout(done, 30_000);
      }),
  );
  await shot(p, "05-video");
  await p.click("[data-ddn-ui=player-close]");

  // 6. paging: 60 more folders, pages of 50 in the main tab
  step("paging");
  await p.evaluate(async () => {
    const core = (window as unknown as { ddnCore: { mkdir(n: string, parent?: string): Promise<string> } }).ddnCore;
    for (let i = 0; i < 60; i++) await core.mkdir(`folder-${String(i).padStart(2, "0")}`);
  });
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /z 64/);
  const page1 = await p.$$eval("[data-ddn=row]", (e) => e.length);
  await p.click("[data-ddn=next]");
  await count(p, /51–64 z 64/);
  r.paging = { page1, page2: await p.$$eval("[data-ddn=row]", (e) => e.length), count: await p.textContent("[data-ddn=count]") };

  // 7. second tab (secondary, in-memory): keyset paging there too + live update over the websocket
  step("second tab");
  const p2 = await newPage(ctx);
  await p2.goto(base);
  await p2.waitForSelector("body[data-ready='1']");
  await count(p2, /z 64/);
  const st2 = { secondary: (await p2.textContent("[data-ddn=status]"))?.includes("karta pomocnicza") ?? false, rows: await p2.$$eval("[data-ddn=row]", (e) => e.length), page2: 0, liveUpdate: false };
  await p2.click("[data-ddn=next]");
  await count(p2, /51–64 z 64/);
  st2.page2 = await p2.$$eval("[data-ddn=row]", (e) => e.length);
  await p2.fill("[data-ddn=folder-name]", "Z drugiej karty");
  await p2.click("[data-ddn=mkdir]");
  await count(p2, /z 65/).catch(async (e) => {
    console.error("p2 count", await p2.textContent("[data-ddn=count]"), await p2.textContent("[data-ddn-ui=toasts]"));
    throw e;
  });
  await count(p, /z 65/).catch(async (e) => {
    console.error("p count", await p.textContent("[data-ddn=count]"), await p.textContent("[data-ddn=status]"));
    throw e;
  });
  st2.liveUpdate = true;
  r.secondTab = st2;
  await p2.close();

  // 8. share link, opened in a fresh context (no account)
  step("share");
  await p.click("[data-ddn=prev]");
  await p.waitForSelector("[data-ddn=row]:has-text('notatki.txt')", { state: "attached" }).catch(() => {});
  if ((await p.locator("[data-ddn=share]").count()) > 0) {
    await p.click("[data-ddn=next]");
    await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator("[data-ddn=share]").click();
    await p.waitForSelector("[data-ddn=share-dialog][open]", { timeout: 30_000 });
    const link = await p.inputValue("[data-ddn=share-link]");
    await shot(p, "06-share-link");
    await p.click("[data-ddn=share-close]");
    const sctx = await browser.newContext({ acceptDownloads: true });
    const sp = await newPage(sctx);
    await sp.goto(link);
    await sp.waitForFunction(() => document.querySelector("[data-ddn=share-file-name]")?.textContent === "notatki.txt", null, { timeout: 30_000 });
    const [sdl] = await Promise.all([sp.waitForEvent("download"), sp.click("[data-ddn=share-get]")]);
    const share: Record<string, unknown> = {
      linkHasKeyAfterHash: /\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{40,}$/.test(link),
      sha256Ok: sha(readFileSync((await sdl.path())!)) === sha(readFileSync(doc)),
      state: await sp.textContent("[data-ddn=share-state]"),
    };
    await shot(sp, "07-share-recipient");
    await p.locator("[data-ddn=shares] button").first().click();
    await p.waitForFunction(() => document.querySelectorAll("[data-ddn=shares] li").length === 0);
    const sp2 = await newPage(sctx);
    await sp2.goto(link);
    await sp2.waitForFunction(() => /nie działa/.test(document.querySelector("[data-ddn=share-state]")?.textContent ?? ""), null, { timeout: 15_000 });
    share.revokedStopsNew = true;
    r.share = share;
    await sctx.close();
  } else r.share = "unavailable (no bot)";

  // 9. pairing a second device (another browser context), on a phone viewport
  step("pairing");
  const phone = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  });
  await phone.addInitScript({ content: "window.__name = (f) => f;" });
  const m = await newPage(phone);
  await m.goto(base);
  await m.waitForSelector("body[data-ready='1']");
  await shot(m, "08-phone-welcome");
  await m.click("[data-ddn=join-pair]");
  await m.fill("[data-ddn=join-name]", "Telefon testowy");
  await m.click("[data-ddn=join-start]");
  await m.waitForSelector("[data-ddn=join-qr] svg");
  const offer = await m.inputValue("[data-ddn=join-offer]");
  r.pairOffer = offer.startsWith("ddn-pair1:");
  await shot(m, "09-phone-qr");
  await p.fill("[data-ddn=pair-code]", offer);
  await p.click("[data-ddn=pair]");
  await p.waitForSelector("[data-ddn-ui=sas-box]:not([hidden])", { timeout: 30_000 });
  const sasA = await p.textContent("[data-ddn=pair-sas]");
  await m.waitForSelector("[data-ddn-ui=join-sas-box]:not([hidden])", { timeout: 15_000 });
  const sasB = await m.textContent("[data-ddn=join-sas]");
  r.sas = { a: sasA, b: sasB, match: !!sasA && sasA === sasB && /^\d{6}$/.test(sasA) };
  await shot(m, "10-phone-sas");
  await m.click("[data-ddn=join-confirm]");
  await m.waitForSelector("[data-ddn=signed-in]:not([hidden])", { timeout: 30_000 });
  await count(m, /z 65/);
  r.phoneCount = await m.textContent("[data-ddn=count]");
  r.phoneNoKitPrompt = !(await m.isVisible("[data-ddn=kit-dialog][open]"));
  await shot(m, "11-phone-files");
  await m.click("[data-ddn=next]");
  const [mdl] = await Promise.all([m.waitForEvent("download", { timeout: 60_000 }), m.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator("[data-ddn=download]").click()]);
  r.phoneDownloadOk = sha(readFileSync((await mdl.path())!)) === sha(readFileSync(doc));
  await m.click(".tab[data-tab=devices]");
  await m.waitForFunction(() => document.querySelectorAll("[data-ddn=device] .dname").length === 2, null, { timeout: 15_000 });
  r.deviceNamesOnPhone = await m.$$eval("[data-ddn=device] .dname", (e) => e.map((x) => x.textContent));
  r.phoneFilesHiddenOnDevicesTab = await m.isHidden("main.files");
  r.phoneNoHorizontalScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await shot(m, "12-phone-devices");
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=device] .dname").length === 2, null, { timeout: 15_000 });
  r.deviceNamesOnLaptop = await p.$$eval("[data-ddn=device] .dname", (e) => e.map((x) => x.textContent));
  await shot(p, "13-laptop-devices");

  // 10. the rescue kit restores the account on a third device
  step("rescue");
  const third = await browser.newContext();
  await third.addInitScript({ content: "window.__name = (f) => f;" });
  const t = await newPage(third);
  await t.goto(base);
  await t.waitForSelector("body[data-ready='1']");
  await t.click("[data-ddn=join-kit-open]");
  await t.fill("[data-ddn=rescue-text]", kit);
  await t.fill("[data-ddn=rescue-name]", "Odtworzony");
  await t.click("[data-ddn=rescue-go]");
  await count(t, /z 65/);
  r.rescueCount = await t.textContent("[data-ddn=count]");
  await third.close();

  // 11. what the server stores: no names in clear
  if (srv) {
    const rows = [srv.db.prepare("SELECT * FROM devices").all(), srv.db.prepare("SELECT entry FROM log").all(), srv.db.prepare("SELECT * FROM shares").all(), srv.db.prepare("SELECT * FROM vault").all()];
    r.serverSeesNoNames = !/Telefon testowy|Laptop testowy|notatki|Wakacje|duzy\.bin|discord\.com\/api\/webhooks/.test(JSON.stringify(rows));
  }
  await phone.close();
  r.pageErrors = errors;
  if (fake) r.discordPosts = fake.posts;
  console.log(JSON.stringify(r, null, 1));
  const share = r.share as { sha256Ok?: boolean; revokedStopsNew?: boolean; linkHasKeyAfterHash?: boolean } | string;
  const v = r.video as { duration: number; t: number; err: string | null; seeked: boolean };
  const pg = r.paging as { page1: number; page2: number };
  const checks: Record<string, boolean> = {
    invite: r.signupWithoutInviteRefused === true,
    mainTab: r.mainTab === true,
    kit: r.kitFormat === true && r.kitQr === true && r.kitDoneDisabledBeforeAck === true && r.kitNotDismissableByEsc === true && r.kitFileHasCode === true,
    progress: (r.progressBigFile as string[]).length >= 2,
    download: r.downloadSha256Ok === true,
    video: !v.err && v.duration > 7 && v.seeked && v.t >= 5.5,
    paging: pg.page1 === 50 && pg.page2 === 14,
    secondTab: st2.secondary && st2.rows === 50 && st2.page2 === 14 && st2.liveUpdate,
    share: typeof share === "string" ? !!remote : share.sha256Ok === true && share.revokedStopsNew === true && share.linkHasKeyAfterHash === true,
    pairing: (r.sas as { match: boolean }).match && r.phoneNoKitPrompt === true && r.phoneDownloadOk === true,
    names: JSON.stringify(r.deviceNamesOnLaptop) === JSON.stringify(["Laptop testowy", "Telefon testowy"]),
    mobile: r.phoneFilesHiddenOnDevicesTab === true && r.phoneNoHorizontalScroll === true,
    rescue: r.rescueCount === "51–65 z 65 pozycji" || /z 65/.test(String(r.rescueCount)),
    serverBlind: r.serverSeesNoNames !== false,
    noPageErrors: errors.length === 0,
  };
  console.log(JSON.stringify(checks));
  ok = Object.values(checks).every(Boolean);
} catch (e) {
  r.pageErrors = errors;
  console.log(JSON.stringify(r, null, 1));
  throw e;
} finally {
  await browser.close();
  await srv?.close();
  await fake?.close();
}
process.exit(ok ? 0 : 1);
