// End-to-end check of the browser app (headless Chromium) against the real
// instance server (`discordrive serve` code path: API + web app on ONE origin,
// invite-only sign-up, share bot) and a fake Discord over HTTP (no network).
// Drives the UI through data-ddn hooks.
//
// Against a deployed instance: DDN_E2E_URL=https://… DDN_E2E_INVITE=ddn-inv-…
// DDN_E2E_WEBHOOK_FILES=a.url:b.url (Discord is real then). DDN_E2E_SHOTS=dir
// saves screenshots. DDN_E2E_LANG=en|pl (default en): the UI language the run
// switches to (English is the default; pl is picked with the header switch).
// DDN_E2E_SCHEME=light|dark: emulated prefers-color-scheme (default light).
// DDN_E2E_MODE=metadata-only|e2ee (default metadata-only): which build-time mode is checked; in
// e2ee the local server runs the e2ee extensions (instance pool on the fake Discord, blobs through
// the instance, no bot: share links refreshed through the webhooks) and the run checks the e2ee
// differences (no channel step with a pool, ddn-kit2, own channel add/remove, cancel).
// Text fields are filled with the REAL keyboard (keyboard.type, Control+V from the clipboard), never
// fill(): fill() sets the value directly and did not notice an onkeydown that cancelled every key.
import { chromium, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DdnServer, DISCORD_ORIGINS, FakeDiscord, type BotRefresher } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
const MODE = (process.env.DDN_E2E_MODE ?? "metadata-only") as "metadata-only" | "e2ee" | "plain";
// plain: the server's names are readable on purpose (that is the mode); the "server blind" check applies to the others.
const SERVER_SIDE = MODE !== "metadata-only";
// Own output dir: the previews of all three modes run from this checkout and serve dist/<mode>.
const buildRoot = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-check-dist-"));
execFileSync(process.execPath, [join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), join(here, "build.ts"), MODE, buildRoot], { stdio: "ignore" });
const dist = join(buildRoot, MODE);
const remote = process.env.DDN_E2E_URL?.replace(/\/$/, "");
const shotDir = process.env.DDN_E2E_SHOTS;
const LANG = process.env.DDN_E2E_LANG === "pl" ? "pl" : "en";
const SCHEME = process.env.DDN_E2E_SCHEME === "dark" ? "dark" : "light";
/** Language-dependent texts the run waits for. */
const L = {
  en: { one: /^1 item$/, four: /^4 items$/, of: (n: number) => new RegExp(`of ${n}`), range: (a: number, b: number, n: number) => new RegExp(`${a}–${b} of ${n}`), uploaded: "Uploaded", dead: /does not work/, kb: /^\d+\.\d KB$/ },
  pl: { one: /^1 pozycja$/, four: /^4 pozycje$/, of: (n: number) => new RegExp(`z ${n}`), range: (a: number, b: number, n: number) => new RegExp(`${a}–${b} z ${n}`), uploaded: "Wysłano", dead: /nie działa/, kb: /^\d+,\d KB$/ },
}[LANG];
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
  // e2ee: the pool is on the instance; DDN_E2E_WEBHOOK_FILES (optional) = one own channel to add and remove.
  if (!invite || (!hookUrls.length && !SERVER_SIDE)) throw new Error("DDN_E2E_INVITE and DDN_E2E_WEBHOOK_FILES are required with DDN_E2E_URL");
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
  let extensions: ConstructorParameters<typeof DdnServer>[0] extends infer O ? (O extends { extensions?: infer X } ? X : never) : never = [];
  let shareBot: BotRefresher = refresher;
  let poolInit: (() => Promise<void>) | null = null;
  if (SERVER_SIDE) {
    // e2ee/plain: instance pool of 2 channels; the browser's two hooks become the "own channel" test.
    const { serverBlobsMode, POOL } = await import("@ddv4/server-discord");
    const { DiscordWebhookTransport } = await import("@ddv4/metadata-client");
    const instDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-inst-"));
    const m = serverBlobsMode({ dataDir: instDir, discordApiOrigin: discordOrigin, cleanupTickMs: 0, snapshotTickMs: 0 });
    extensions = m.extensions;
    if (MODE === "plain") {
      const { PlainExtension } = await import("@ddv4/server-discord/plain");
      extensions = [...m.extensions, new PlainExtension({ dataDir: instDir, blobs: m.blobs })];
    }
    shareBot = m.shareRefresher; // no bot: share links refreshed through the instance webhooks
    const pool = [fake.addWebhook("1550000000000000201").url, fake.addWebhook("1550000000000000202").url];
    poolInit = async () => {
      for (const u of pool) await m.hooks().add(POOL, u, new DiscordWebhookTransport({ apiOrigin: discordOrigin }));
    };
  }
  const s = new DdnServer({
    signup: "invite",
    rateLimits: false,
    mode: MODE,
    extensions,
    web: { dir: dist, connectSrc: [...DISCORD_ORIGINS, discordOrigin], config: { discordApiOrigin: discordOrigin, mode: MODE } },
    bot: shareBot,
    cdnOrigins: [discordOrigin],
  });
  await poolInit?.();
  srv = s;
  base = (await s.listen(0)).url;
  invite = s.invites.create().code;
}

// Lint: no on* handler may be an arrow that returns a boolean expression (`onkeydown = (e) => e.key === "Enter" && …`
// returns false for every other key, which cancels it: the webhook field accepted no typing or paste).
const lint: string[] = [];
const walkSrc = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walkSrc(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
for (const f of walkSrc(join(here, "src"))) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    // `.onxxx = (…) => <expression>` (not a block, not `void …`) or `return false` inside an on* handler line
    if (/\.on[a-z]+\s*=\s*(\([^)]*\)|\w+)\s*=>(?!\s*(?:\{|void\b))/.test(line) && /&&|\|\||===|!==|\bfalse\b/.test(line)) lint.push(`${f.slice(here.length + 1)}:${i + 1}: ${line.trim()}`);
  });
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

// A preview on a plain-http VPN address (no domain yet) is not a secure context (no WebCrypto, no
// service worker), and Chromium's headless shell ignores --unsafely-treat-insecure-origin-as-secure.
// DDN_E2E_TUNNEL=1: reach it through a local proxy (localhost:<free port> -> the instance) that
// rewrites /config.js so the app uses the proxy origin; every request still lands on the real
// preview instance (API, websocket, web app), Discord is real.
let tunnel: import("node:http").Server | null = null;
if (remote && process.env.DDN_E2E_TUNNEL === "1") {
  const http = await import("node:http");
  const net = await import("node:net");
  const target = new URL(remote);
  let local = "";
  tunnel = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers: { ...req.headers, host: target.host, ...(req.headers.origin ? { origin: remote } : {}) } }, (r) => {
      if (req.url === "/config.js") {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => {
          b = b.split(remote).join(local);
          const h = { ...r.headers, "content-length": String(Buffer.byteLength(b)) };
          res.writeHead(r.statusCode ?? 200, h);
          res.end(b);
        });
        return;
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  tunnel.on("upgrade", (req, sock, head) => {
    const u = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: target.host, origin: remote }).map(([k, v]) => `${k}: ${v}`), "", ""];
      u.write(lines.join("\r\n"));
      if (head.length) u.write(head);
      sock.pipe(u).pipe(sock);
    });
    const end = () => (sock.destroy(), u.destroy());
    u.on("error", end);
    sock.on("error", end);
  });
  await new Promise<void>((ok) => tunnel!.listen(0, "127.0.0.1", ok));
  local = `http://localhost:${(tunnel.address() as { port: number }).port}`;
  base = local;
}
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
/** Type into a field with the real keyboard (click, select all, type). */
async function typeInto(p: Page, sel: string, text: string) {
  await p.click(sel);
  await p.keyboard.press("Control+A");
  await p.keyboard.press("Delete");
  await p.keyboard.type(text, { delay: 2 });
}
/** Paste into a field with Control+V from the system clipboard (what a user does with a webhook URL). */
async function pasteInto(p: Page, sel: string, text: string) {
  await p.evaluate((t) => navigator.clipboard.writeText(t), text);
  await p.click(sel);
  await p.keyboard.press("Control+A");
  await p.keyboard.press("Delete");
  await p.keyboard.press("Control+V");
}
/** Click a sidebar link (opens the drawer first on a phone). */
async function nav(p: Page, name: "files" | "trash" | "devices" | "settings") {
  if (await p.isVisible("[data-ddn-ui=nav-open]")) {
    await p.click("[data-ddn-ui=nav-open]");
    await p.waitForSelector("[data-ddn-ui=signed-in-shell][data-drawer=open]");
  }
  await p.click(`a[data-nav=${name}]`);
  await p.waitForSelector(`[data-page=${name}]:not([hidden])`);
}
const count = (p: Page, re: RegExp) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-ddn=count]")?.textContent ?? ""), re.source, { timeout: 30_000 });

let ok = false;
const r: Record<string, unknown> = { base };
try {
  // Polish browser locale on purpose: the app must still start in English (no navigator.language).
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 }, colorScheme: SCHEME, locale: "pl-PL", permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript({ content: "window.__name = (f) => f;" }); // tsx wraps named fns passed to evaluate()
  const p = await newPage(ctx);
  await p.goto(base);
  await p.waitForSelector("body[data-ready='1']");
  // i18n: English by default (whatever navigator.language says), switch without reload, choice kept.
  r.defaultLang = await p.evaluate(() => ({ html: document.documentElement.lang, h1: document.querySelector("[data-auth=create] h1")?.textContent, nav: navigator.language }));
  if (LANG === "pl") {
    await p.click("[data-ddn=lang] [data-lang=pl]");
    await p.waitForFunction(() => document.documentElement.lang === "pl");
    await p.reload();
    await p.waitForSelector("body[data-ready='1']");
  }
  r.lang = await p.evaluate(() => ({ html: document.documentElement.lang, h1: document.querySelector("[data-auth=create] h1")?.textContent, pressed: document.querySelector("[data-ddn=lang] [aria-pressed=true]")?.getAttribute("data-lang"), title: document.title }));
  // Look: Cobalt follows the system by default; the light/dark/system switch (ColorModeToggle) overrides it.
  r.theme = await p.evaluate(() => ({ resolved: document.documentElement.dataset.theme, mode: document.documentElement.dataset.themeMode, bg: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.querySelector("[data-auth=create] h1")!).fontFamily }));
  const other = SCHEME === "dark" ? "light" : "dark";
  await p.click(`main[data-ddn=signed-out] > .auth-tools [data-mode=${other}]`);
  r.themeToggled = await p.evaluate(() => ({ resolved: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
  await p.click("main[data-ddn=signed-out] > .auth-tools [data-mode=system]");

  r.serverFieldHidden = await p.isHidden("[data-ddn-ui=server-field]");
  r.inviteFieldShown = await p.isVisible("[data-ddn=invite]");
  await shot(p, "01-welcome");

  // 1. sign-up: without a code refused, with the code OK
  step("sign-up");
  await typeInto(p, "[data-ddn=device-name]", "Laptop testowy");
  await p.click("[data-ddn=create]");
  await p.waitForSelector(".toast.err");
  const refusal = (await p.textContent(".toast.err")) ?? "";
  // A readable message, no technical code in it.
  r.signupWithoutInviteRefused = /invite code|kodu zaproszenia/.test(refusal) && !/invite_required/.test(refusal);
  await typeInto(p, "[data-ddn=invite]", invite);
  r.typedInvite = (await p.inputValue("[data-ddn=invite]")) === invite;
  await p.click("[data-ddn=create]");
  // First run: onboarding (channel, then the rescue kit), not the file list.
  await p.waitForURL((u) => u.pathname === "/welcome", { timeout: 30_000 });
  // e2ee with an instance pool: the onboarding starts at the rescue kit (no channel to connect).
  await p.waitForSelector(SERVER_SIDE ? "[data-ddn=kit-dialog][open]" : "[data-ddn-ui=onboarding]:not([hidden]) [data-ddn=webhook-url]", { timeout: 30_000 });

  // 2. channel wizard; the rescue kit is forced right after the first channel
  step("channels");
  await shot(p, "02-wizard");
  if (!SERVER_SIDE) {
    // Paste with Control+V (the bug of 533bf9d: onkeydown returned false and cancelled every key but Enter).
    await pasteInto(p, "[data-ddn=webhook-url]", hookUrls[0]!);
    r.pastedWebhook = (await p.inputValue("[data-ddn=webhook-url]")) === hookUrls[0];
    await p.keyboard.press("Enter");
  } else {
    // e2ee with an instance pool: no channel step, the kit comes right away.
    r.noChannelStepWithPool = true;
  }
  await p.waitForSelector("[data-ddn=kit-dialog][open]", { timeout: 30_000 });
  await p.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("[data-ddn=kit-text]")?.value ?? "").length > 20);
  const kit = await p.inputValue("[data-ddn=kit-text]");
  r.kitFormat = kit.startsWith(SERVER_SIDE ? "ddn-kit2:" : "ddn-kit1:");
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
  // After the kit: straight to Files; channels and the kit are NOT on the files page.
  await p.waitForURL((u) => u.pathname === "/");
  await p.waitForSelector("[data-page=files]:not([hidden])");
  await p.waitForSelector("[data-ddn=status][data-tab-role]");
  r.mainTab = (await p.getAttribute("[data-ddn=status]", "data-tab-role")) === "main";
  r.filesPageClean = await p.evaluate(() => {
    const page = document.querySelector("[data-page=files]")!;
    const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].some((e) => e.offsetParent !== null);
    return !page.querySelector("[data-ddn=webhook-url], [data-ddn=kit-show], [data-ddn=pair-code], [data-ddn-ui=devices]") && !visible("[data-ddn=webhook-url]") && !visible("[data-ddn=advice]");
  });
  // Channels live in Settings; a reload of /settings stays there.
  await nav(p, "settings");
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  r.settingsSurvivesReload = new URL(p.url()).pathname === "/settings" && (await p.isVisible("[data-page=settings] [data-ddn=webhook-url]"));
  if (!SERVER_SIDE && hookUrls[1]) {
    // Type the second one key by key (not paste) and add with the button.
    await typeInto(p, "[data-ddn=webhook-url]", hookUrls[1]);
    r.typedWebhook = (await p.inputValue("[data-ddn=webhook-url]")) === hookUrls[1];
    await p.click("[data-ddn=add-webhook]");
    await p.waitForFunction(() => document.querySelector("[data-ddn-ui=hook-count]")?.textContent?.startsWith("2"), null, { timeout: 30_000 });
  }
  if (SERVER_SIDE) {
    // The instance pool is listed (count only), an own channel replaces it and can be removed again.
    await p.waitForSelector("[data-ddn=pool]");
    r.poolShown = await p.textContent("[data-ddn=pool]");
    const poolCount = await p.textContent("[data-ddn-ui=hook-count]");
    if (hookUrls[0]) {
      await pasteInto(p, "[data-ddn=webhook-url]", hookUrls[0]);
      r.pastedWebhook = (await p.inputValue("[data-ddn=webhook-url]")) === hookUrls[0];
      await p.click("[data-ddn=add-webhook]");
      await p.waitForSelector("[data-ddn=remove-webhook]", { timeout: 30_000 });
      r.ownChannel = { poolHidden: await p.isHidden("[data-ddn=pool]"), count: await p.textContent("[data-ddn-ui=hook-count]") };
      await p.click("[data-ddn=remove-webhook]");
      await p.waitForSelector("[data-ddn=pool]", { timeout: 30_000 });
      (r.ownChannel as Record<string, unknown>).backToPool = (await p.textContent("[data-ddn-ui=hook-count]")) === poolCount;
    } else r.pastedWebhook = true;
  }
  r.advice = await p.textContent("[data-ddn=advice]");
  await shot(p, "03b-settings");
  // Cobalt fonts are local files (CSP: 'self' only) and really load: Space Grotesk / Inter / JetBrains Mono.
  r.fontsLoaded = await p.evaluate(async () => (await document.fonts.ready, [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")))].sort()));
  await nav(p, "files");

  // 3. upload with byte progress
  step("upload");
  await p.click("[data-ddn=new-folder]");
  await p.waitForSelector("[data-ddn=folder-dialog][open]");
  await p.keyboard.type("Wakacje", { delay: 2 }); // the field has focus when the dialog opens
  r.typedFolder = (await p.inputValue("[data-ddn=folder-name]")) === "Wakacje";
  await p.keyboard.press("Enter");
  await count(p, L.one);
  r.pagerHiddenOnOnePage = await p.isHidden("[data-ddn=next]");
  const progress: string[] = [];
  await p.exposeFunction("__progress", (s: string) => void progress.push(s));
  await p.evaluate(() => {
    const q = document.querySelector("[data-ddn-ui=queue-list]")!;
    new MutationObserver(() => {
      for (const li of q.querySelectorAll("[data-ddn=queue-item]")) (window as unknown as { __progress(s: string): void }).__progress(`${li.firstElementChild?.textContent}:${li.querySelector(".qstate")?.textContent}`);
    }).observe(q, { childList: true, characterData: true, subtree: true });
  });
  await p.setInputFiles("[data-ddn=file]", [doc, video, big]);
  await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 300_000 });
  await count(p, L.four);
  r.docSize = await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator(".size").textContent();
  const bigSteps = [...new Set(progress.filter((x) => x.startsWith("duzy.bin:") && /%$/.test(x)))];
  r.progressBigFile = bigSteps;
  if (MODE === "plain") {
    // Thumbnail of the video (made on the server in the background) replaces the type badge.
    // Without a reload: the list asks again until the server has made it.
    const tThumb = Date.now();
    await p.waitForSelector("[data-ddn=row]:has-text('klip.webm') img[data-ddn=thumb]", { timeout: 60_000 }).catch(() => {});
    r.thumbnailAfterMs = Date.now() - tThumb;
    r.thumbnail = await p.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>("[data-ddn=row] img[data-ddn=thumb]");
      return img ? { w: img.naturalWidth, h: img.naturalHeight, ok: img.complete && img.naturalWidth > 0 } : null;
    });
    // Server search (by name, the server knows them in plain mode).
    await typeInto(p, "[data-ddn=search]", "NOTATKI");
    await p.waitForFunction(() => document.querySelectorAll("[data-ddn=row]").length === 1 && /notatki\.txt/.test(document.querySelector("[data-ddn=row]")?.textContent ?? ""), null, { timeout: 15_000 }).catch(() => {});
    r.search = { rows: await p.$$eval("[data-ddn=row]", (e) => e.map((x) => x.querySelector("[title]")?.getAttribute("title"))), meta: await p.textContent("[data-ddn-ui=folder-meta]") };
    await shot(p, "04b-search");
    await typeInto(p, "[data-ddn=search]", "");
    await p.keyboard.press("Enter");
    await count(p, L.four);
  }
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
  r.videoSource = await p.getAttribute("[data-ddn=player]", "data-source");
  await shot(p, "05-video");
  await p.click("[data-ddn-ui=player-close]");

  // 5b. a folder has its own address: open it, reload, the breadcrumb is rebuilt from the index
  step("folder route");
  await p.locator("[data-ddn=row]", { hasText: "Wakacje" }).locator("a").click();
  await p.waitForURL(/\/folder\//);
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=folder-title]")?.textContent === "Wakacje");
  r.folderRoute = { path: new URL(p.url()).pathname.startsWith("/folder/"), crumb: await p.textContent("[data-ddn-ui=crumbs] [aria-current=page]") };
  await p.goBack();
  await p.waitForFunction(() => location.pathname === "/");
  await count(p, L.four);

  // 6. paging: 60 more folders, pages of 50 in the main tab
  step("paging");
  await p.evaluate(async () => {
    const core = (window as unknown as { ddnCore: { mkdir(n: string, parent?: string): Promise<string> } }).ddnCore;
    for (let i = 0; i < 60; i++) await core.mkdir(`folder-${String(i).padStart(2, "0")}`);
  });
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await count(p, L.of(64));
  r.pagerShownOnManyPages = await p.isVisible("[data-ddn=next]");
  const page1 = await p.$$eval("[data-ddn=row]", (e) => e.length);
  await p.click("[data-ddn=next]");
  await count(p, L.range(51, 64, 64));
  r.paging = { page1, page2: await p.$$eval("[data-ddn=row]", (e) => e.length), count: await p.textContent("[data-ddn=count]") };

  // 7. second tab (secondary, in-memory): keyset paging there too + live update over the websocket
  step("second tab");
  const p2 = await newPage(ctx);
  await p2.goto(base);
  await p2.waitForSelector("body[data-ready='1']");
  await count(p2, L.of(64));
  await p2.waitForSelector("[data-ddn=status][data-tab-role]");
  const st2 = { secondary: (await p2.getAttribute("[data-ddn=status]", "data-tab-role")) === "secondary", rows: await p2.$$eval("[data-ddn=row]", (e) => e.length), page2: 0, liveUpdate: false };
  await p2.click("[data-ddn=next]");
  await count(p2, L.range(51, 64, 64));
  st2.page2 = await p2.$$eval("[data-ddn=row]", (e) => e.length);
  await p2.click("[data-ddn=new-folder]");
  await p2.waitForSelector("[data-ddn=folder-dialog][open]");
  await typeInto(p2, "[data-ddn=folder-name]", "Z drugiej karty");
  await p2.click("[data-ddn=mkdir]");
  await count(p2, L.of(65)).catch(async (e) => {
    console.error("p2 count", await p2.textContent("[data-ddn=count]"), await p2.textContent("[data-ddn-ui=toasts]"));
    throw e;
  });
  await count(p, L.of(65)).catch(async (e) => {
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
    const sctx = await browser.newContext({ acceptDownloads: true, colorScheme: SCHEME });
    // The recipient's browser has its own language choice; use the run's language there too.
    await sctx.addInitScript({ content: `try { localStorage.setItem("ddn.lang", ${JSON.stringify(LANG)}) } catch {}` });
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
    await nav(p, "settings");
    await p.waitForSelector("[data-ddn=shares] li");
    await shot(p, "06b-settings-sharing");
    await p.locator("[data-ddn=shares] button").first().click();
    await p.waitForFunction(() => document.querySelectorAll("[data-ddn=shares] li").length === 0);
    await nav(p, "files");
    const sp2 = await newPage(sctx);
    await sp2.goto(link);
    await sp2.waitForFunction((re) => new RegExp(re).test(document.querySelector("[data-ddn=share-state]")?.textContent ?? ""), L.dead.source, { timeout: 15_000 });
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
    colorScheme: SCHEME,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await phone.addInitScript({ content: `window.__name = (f) => f; try { localStorage.setItem("ddn.lang", ${JSON.stringify(LANG)}) } catch {}` });
  const m = await newPage(phone);
  await m.goto(base);
  await m.waitForSelector("body[data-ready='1']");
  await shot(m, "08-phone-welcome");
  await m.click("[data-ddn=join-pair]");
  await m.waitForURL((u) => u.pathname === "/join");
  await typeInto(m, "[data-ddn=join-name]", "Telefon testowy");
  await m.click("[data-ddn=join-start]");
  await m.waitForSelector("[data-ddn=join-qr] svg");
  const offer = await m.inputValue("[data-ddn=join-offer]");
  r.pairOffer = offer.startsWith("ddn-pair1:");
  await shot(m, "09-phone-qr");
  await nav(p, "devices");
  await pasteInto(p, "[data-ddn=pair-code]", offer);
  r.pastedPairCode = (await p.inputValue("[data-ddn=pair-code]")) === offer;
  await p.click("[data-ddn=pair]");
  await p.waitForSelector("[data-ddn-ui=sas-box]:not([hidden])", { timeout: 30_000 });
  const sasA = await p.textContent("[data-ddn=pair-sas]");
  await m.waitForSelector("[data-ddn-ui=join-sas-box]:not([hidden])", { timeout: 15_000 });
  const sasB = await m.textContent("[data-ddn=join-sas]");
  r.sas = { a: sasA, b: sasB, match: !!sasA && sasA === sasB && /^\d{6}$/.test(sasA) };
  await shot(m, "10-phone-sas");
  await m.click("[data-ddn=join-confirm]");
  await m.waitForSelector("[data-ddn=signed-in]:not([hidden]) [data-page=files]:not([hidden])", { timeout: 30_000 });
  await count(m, L.of(65));
  r.phoneCount = await m.textContent("[data-ddn=count]");
  r.phoneNoKitPrompt = !(await m.isVisible("[data-ddn=kit-dialog][open]"));
  await shot(m, "11-phone-files");
  await m.click("[data-ddn=next]");
  const [mdl] = await Promise.all([m.waitForEvent("download", { timeout: 60_000 }), m.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator("[data-ddn=download]").click()]);
  r.phoneDownloadOk = sha(readFileSync((await mdl.path())!)) === sha(readFileSync(doc));
  // Phone: hamburger + drawer (MainLayout), no bottom tabs.
  r.phoneSidebarHiddenUntilMenu = !(await m.isVisible("[data-ddn-ui=sidebar] a[data-nav=devices]"));
  await m.click("[data-ddn-ui=nav-open]");
  await m.waitForSelector("[data-ddn-ui=signed-in-shell][data-drawer=open]");
  await m.waitForTimeout(300);
  await shot(m, "11b-phone-drawer");
  await m.click("a[data-nav=devices]");
  await m.waitForSelector("[data-page=devices]:not([hidden])");
  r.phoneDrawerClosedAfterNav = (await m.getAttribute("[data-ddn-ui=signed-in-shell]", "data-drawer")) !== "open";
  await m.waitForFunction(() => document.querySelectorAll("[data-ddn=device] .dname").length === 2, null, { timeout: 15_000 });
  r.deviceNamesOnPhone = await m.$$eval("[data-ddn=device] .dname", (e) => e.map((x) => x.textContent));
  r.phoneFilesHiddenOnDevicesTab = await m.isHidden("[data-page=files]");
  r.phoneNoHorizontalScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await shot(m, "12-phone-devices");
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  r.devicesSurvivesReload = new URL(p.url()).pathname === "/devices";
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=device] .dname").length === 2, null, { timeout: 15_000 });
  r.deviceNamesOnLaptop = await p.$$eval("[data-ddn=device] .dname", (e) => e.map((x) => x.textContent));
  await shot(p, "13-laptop-devices");

  // 10. the rescue kit restores the account on a third device
  step("rescue");
  const third = await browser.newContext({ colorScheme: SCHEME });
  await third.addInitScript({ content: `window.__name = (f) => f; try { localStorage.setItem("ddn.lang", ${JSON.stringify(LANG)}) } catch {}` });
  const t = await newPage(third);
  await t.goto(base);
  await t.waitForSelector("body[data-ready='1']");
  await t.click("[data-ddn=join-kit-open]");
  await t.waitForURL((u) => u.pathname === "/restore");
  await t.evaluate((k) => navigator.clipboard.writeText(k), kit).catch(() => {});
  await typeInto(t, "[data-ddn=rescue-text]", kit);
  await typeInto(t, "[data-ddn=rescue-name]", "Odtworzony");
  await t.click("[data-ddn=rescue-go]");
  await count(t, L.of(65));
  r.rescueCount = await t.textContent("[data-ddn=count]");
  await third.close();

  // 10b. rename (rule 2 suffix + Undo), row menu, selection + Move to… picker, drag onto a breadcrumb,
  // trash / restore / delete for good / empty trash. Inside "Wakacje", so the counts above stay as they are.
  step("rename, move, trash");
  const wakId = await p.evaluate(async () => {
    const core = (window as unknown as { ddnCore: { list(f: string, a?: string, n?: number): Promise<{ rows: { id: string; name: string }[] }> } }).ddnCore;
    return (await core.list("root", undefined, 500)).rows.find((x) => x.name === "Wakacje")!.id;
  });
  await p.goto(`${base}/folder/${wakId}`);
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=folder-title]")?.textContent === "Wakacje");
  await p.click("[data-ddn=new-folder]");
  await p.waitForSelector("[data-ddn=folder-dialog][open]");
  await p.keyboard.type("Archiwum", { delay: 2 });
  await p.keyboard.press("Enter");
  await count(p, L.one);
  await p.setInputFiles("[data-ddn=file]", [doc]);
  await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 120_000 });
  await count(p, /^2 /);
  const ops: Record<string, unknown> = {};
  const menu = async (row: string, action: string) => {
    await p.locator("[data-ddn=row]", { hasText: row }).locator("[data-ddn=row-more]").click();
    await p.waitForSelector("[data-ddn=row-menu]:not([hidden])");
    await p.click(`[data-ddn=menu-${action}]`);
  };
  const rowNames = () => p.$$eval("[data-ddn=row] .nm > :last-child", (e) => e.map((x) => x.textContent));
  // Rename onto the folder's name (case-insensitive collision): rule 2 gives "archiwum (2)" and says so.
  await menu("notatki.txt", "rename");
  await p.waitForSelector("[data-ddn=rename-dialog][open]");
  ops.renameSelectsBase = await p.evaluate(() => {
    const i = document.querySelector<HTMLInputElement>("[data-ddn=rename-name]")!;
    return i.value.slice(i.selectionStart!, i.selectionEnd!) === "notatki";
  });
  await typeInto(p, "[data-ddn=rename-name]", "a/b");
  ops.renameRejectsSlash = await p.isVisible("[data-ddn=rename-error]");
  await typeInto(p, "[data-ddn=rename-name]", "archiwum");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=row] .nm > :last-child")].some((x) => x.textContent === "archiwum (2)"), null, { timeout: 30_000 });
  ops.suffixToast = await p.locator(".toast", { hasText: "archiwum (2)" }).first().textContent();
  await p.locator("[data-ddn=toast-undo]").last().click();
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=row] .nm > :last-child")].some((x) => x.textContent === "notatki.txt"), null, { timeout: 30_000 });
  ops.renameUndo = true;
  await shot(p, "14-rename-undo");
  // Select the file, Move to… -> Wakacje / Archiwum in the picker.
  await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator("[data-ddn=select]").check();
  await p.waitForSelector("[data-ddn=bulk]:not([hidden])");
  ops.bulkCount = await p.textContent("[data-ddn=bulk-count]");
  await p.click("[data-ddn=bulk-move]");
  await p.waitForSelector("[data-ddn=move-dialog][open]");
  await p.click(`[data-ddn=move-folder][data-id="${wakId}"]`);
  await p.locator("[data-ddn=move-folder]", { hasText: "Archiwum" }).click();
  await shot(p, "15-move-picker");
  await p.click("[data-ddn=move-here]");
  await count(p, L.one);
  ops.movedOut = JSON.stringify(await rowNames()) === JSON.stringify(["Archiwum"]);
  // Drag back from Archiwum onto the "Wakacje" breadcrumb.
  await p.locator("[data-ddn=row]", { hasText: "Archiwum" }).locator("a").click();
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=folder-title]")?.textContent === "Archiwum");
  await count(p, L.one);
  await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).dragTo(p.locator(`[data-ddn-ui=crumbs] a[data-drop="${wakId}"]`));
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=row]").length === 0, null, { timeout: 30_000 });
  ops.dragToCrumb = true;
  await p.goBack();
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=folder-title]")?.textContent === "Wakacje");
  await count(p, /^2 /);
  // Rule 5 through the core: a move into a folder in the trash is skipped with a notice.
  // Trash the folder from the row menu, check the Trash page, restore it, trash it again, delete it for good.
  const archId = await p.locator("[data-ddn=row]", { hasText: "Archiwum" }).getAttribute("data-id");
  await menu("Archiwum", "trash");
  await count(p, L.one);
  ops.rule5 = await p.evaluate(
    async ([file, folder]) => (await (window as unknown as { ddnCore: { move(i: string[], t: string): Promise<{ outcome: string; notices: { code: string }[] }> } }).ddnCore.move([file!], folder!)).notices.map((n) => n.code),
    [await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).getAttribute("data-id"), archId],
  );
  await nav(p, "trash" as never);
  await p.waitForSelector("[data-ddn=trash-row]");
  ops.trashRow = { name: await p.locator("[data-ddn=trash-row]").first().locator(".nm").textContent(), left: await p.textContent("[data-ddn=trash-left]") };
  await shot(p, "16-trash");
  await p.click("[data-ddn=trash-restore]");
  await p.waitForSelector("[data-ddn-ui=trash-none]:not([hidden])");
  await nav(p, "files");
  await p.goto(`${base}/folder/${wakId}`);
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /^2 /);
  ops.restored = true;
  // Both into the trash with the bulk bar, then delete one for good and empty the trash.
  await p.check("[data-ddn=select-all]");
  ops.selectAll = await p.textContent("[data-ddn=bulk-count]");
  await p.click("[data-ddn=bulk-trash]");
  await p.waitForSelector("[data-ddn-ui=empty]:not([hidden])");
  await nav(p, "trash" as never);
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=trash-row]").length === 2);
  await p.locator("[data-ddn=trash-row]", { hasText: "Archiwum" }).locator("[data-ddn=trash-purge]").click();
  await p.waitForSelector("[data-ddn=confirm-dialog][open]");
  await p.click("[data-ddn=confirm-yes]");
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=trash-row]").length === 1);
  await p.click("[data-ddn=trash-empty]");
  await p.waitForSelector("[data-ddn=confirm-dialog][open]");
  await shot(p, "17-empty-trash-confirm");
  await p.click("[data-ddn=confirm-yes]");
  await p.waitForSelector("[data-ddn-ui=trash-none]:not([hidden])");
  ops.emptied = true;
  r.ops = ops;

  // 11. what the server stores: no names in clear
  if (srv) {
    const tables = ["devices", "log", "shares", "vault", "s_blobs", "s_uploads", "inst_hooks", "s_snapshots"].filter((t) => srv!.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const rows = tables.map((t) => srv!.db.prepare(`SELECT * FROM ${t}`).all());
    r.serverTables = tables;
    r.serverSeesNoNames = !/Telefon testowy|Laptop testowy|notatki|Wakacje|duzy\.bin|discord\.com\/api\/webhooks/.test(JSON.stringify(rows));
  }
  await phone.close();
  r.pageErrors = errors;
  r.lint = lint;
  if (fake) r.discordPosts = fake.posts;
  console.log(JSON.stringify(r, null, 1));
  const share = r.share as { sha256Ok?: boolean; revokedStopsNew?: boolean; linkHasKeyAfterHash?: boolean } | string;
  const v = r.video as { duration: number; t: number; err: string | null; seeked: boolean };
  const pg = r.paging as { page1: number; page2: number };
  const dl0 = r.defaultLang as { html: string; h1: string; nav: string };
  const lg = r.lang as { html: string; h1: string; pressed: string; title: string };
  const checks: Record<string, boolean> = {
    noFalseReturningHandlers: lint.length === 0,
    keyboard: r.typedInvite === true && r.pastedWebhook === true && r.typedFolder === true && (SERVER_SIDE || !hookUrls[1] || r.typedWebhook === true) && r.pastedPairCode === true,
    ...(MODE === "plain"
      ? {
          plainThumbnail: !!(r.thumbnail as { ok: boolean } | null)?.ok && Math.max((r.thumbnail as { w: number }).w, (r.thumbnail as { h: number }).h) <= 320 && (r.thumbnailAfterMs as number) < 30_000,
          plainSearch: JSON.stringify((r.search as { rows: string[] }).rows) === JSON.stringify(["notatki.txt"]),
          plainServerStreaming: r.videoSource === "server",
        }
      : {}),
    ...(SERVER_SIDE
      ? { modeChannels: r.noChannelStepWithPool === true && /\d+ (shared|wspóln)/.test(String(r.poolShown)) && (!hookUrls[0] || ((r.ownChannel as { poolHidden: boolean; backToPool: boolean }).poolHidden && (r.ownChannel as { backToPool: boolean }).backToPool)) }
      : {}),
    layout: r.filesPageClean === true && r.settingsSurvivesReload === true && r.devicesSurvivesReload === true && (r.folderRoute as { path: boolean; crumb: string }).path && (r.folderRoute as { crumb: string }).crumb === "Wakacje",
    fonts: JSON.stringify(r.fontsLoaded) === JSON.stringify(["Inter", "JetBrains Mono", "Space Grotesk"]),
    theme: (r.theme as { resolved: string }).resolved === SCHEME && (r.themeToggled as { resolved: string; bg: string }).resolved !== SCHEME && (r.themeToggled as { bg: string }).bg !== (r.theme as { bg: string }).bg,
    i18nDefaultEnglish: dl0.nav === "pl-PL" && dl0.html === "en" && dl0.h1 === "Create account",
    i18nLang: lg.html === LANG && lg.pressed === LANG && (LANG === "en" ? lg.h1 === "Create account" : lg.h1 === "Załóż konto"),
    i18nSizeFormat: L.kb.test(String(r.docSize)),
    pager: r.pagerHiddenOnOnePage === true && r.pagerShownOnManyPages === true,
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
    mobile: r.phoneFilesHiddenOnDevicesTab === true && r.phoneNoHorizontalScroll === true && r.phoneSidebarHiddenUntilMenu === true && r.phoneDrawerClosedAfterNav === true,
    rescue: L.of(65).test(String(r.rescueCount)),
    renameMoveTrash: (() => {
      const o = r.ops as Record<string, unknown> | undefined;
      if (!o) return false;
      return (
        o.renameSelectsBase === true && o.renameRejectsSlash === true && /archiwum \(2\)/.test(String(o.suffixToast)) && o.renameUndo === true &&
        /^(1 selected|Zaznaczono 1)$/.test(String(o.bulkCount)) && o.movedOut === true && o.dragToCrumb === true &&
        JSON.stringify(o.rule5) === JSON.stringify(["move_target_in_trash"]) && /Archiwum/.test(String((o.trashRow as { name: string }).name)) &&
        /30/.test(String((o.trashRow as { left: string }).left)) && o.restored === true && /2/.test(String(o.selectAll)) && o.emptied === true
      );
    })(),
    serverBlind: MODE === "plain" ? true : r.serverSeesNoNames !== false,
    noPageErrors: errors.length === 0,
  };
  r.mode = MODE;
  console.log(JSON.stringify({ mode: MODE, ...checks }));
  ok = Object.values(checks).every(Boolean);
} catch (e) {
  r.pageErrors = errors;
  console.log(JSON.stringify(r, null, 1));
  throw e;
} finally {
  await browser.close();
  tunnel?.close();
  await srv?.close();
  await fake?.close();
}
process.exit(ok ? 0 : 1);
