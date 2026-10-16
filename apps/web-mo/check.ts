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
  // Third webhook for the channel step (move / remove anyway / paste again).
  hookUrls.push(fake.addWebhook("1550000000000000103").url);
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
    web: { dir: dist, connectSrc: [...DISCORD_ORIGINS, discordOrigin], config: { discordApiOrigin: discordOrigin, mode: MODE, streamMinBytes: 1024 * 1024 } },
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
/** Settings → Channels is folded when there are channels: unfold it. */
async function openChannels(p: Page) {
  await p.waitForSelector("[data-ddn=channels-toggle]");
  if ((await p.getAttribute("[data-ddn=channels-toggle]", "aria-expanded")) !== "true") await p.click("[data-ddn=channels-toggle]");
  await p.waitForSelector("[data-ddn=channels-body]:not([hidden])");
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

  r.createSub = await p.textContent("[data-auth=create] .sub");
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
  r.settingsSurvivesReload = new URL(p.url()).pathname === "/settings" && (await p.isVisible("[data-page=settings] [data-ddn=channels-toggle]"));
  await openChannels(p);
  if (!SERVER_SIDE && hookUrls[1]) {
    // Type the second one key by key (not paste) and add with the button.
    await typeInto(p, "[data-ddn=webhook-url]", hookUrls[1]);
    r.typedWebhook = (await p.inputValue("[data-ddn=webhook-url]")) === hookUrls[1];
    await p.click("[data-ddn=add-webhook]");
    await p.waitForFunction(() => document.querySelector("[data-ddn-ui=hook-count]")?.textContent?.startsWith("2"), null, { timeout: 30_000 });
    // Several addresses pasted at once (owner, 2026-10-15): one per line in the clipboard → all added
    // with one click, a duplicate of an existing channel is not counted twice.
    if (fake) {
      const many = [fake.addWebhook("1550000000000000103").url, fake.addWebhook("1550000000000000104").url, fake.addWebhook("1550000000000000105").url];
      await pasteInto(p, "[data-ddn=webhook-url]", [...many, hookUrls[1]].join("\n"));
      await p.click("[data-ddn=add-webhook]");
      await p.waitForFunction(() => document.querySelector("[data-ddn-ui=hook-count]")?.textContent?.startsWith("5"), null, { timeout: 60_000 });
      r.pasteManyWebhooks = { count: (await p.textContent("[data-ddn-ui=hook-count]"))?.trim(), fieldEmpty: (await p.inputValue("[data-ddn=webhook-url]")) === "" };
    }
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
      // The remove dialog: an empty own channel, "remove anyway" needs no acknowledgement.
      await p.click("[data-ddn=remove-webhook]");
      await p.waitForSelector("[data-ddn=channel-dialog][open]");
      await p.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-ddn=chd-opt-remove]")!.disabled, null, { timeout: 30_000 });
      await p.check("[data-ddn=chd-opt-remove]");
      await p.click("[data-ddn=chd-go]");
      await p.waitForSelector("[data-ddn=pool]", { timeout: 30_000 });
      (r.ownChannel as Record<string, unknown>).backToPool = (await p.textContent("[data-ddn-ui=hook-count]")) === poolCount;
    } else r.pastedWebhook = true;
  }
  r.advice = await p.textContent("[data-ddn=advice]");
  await shot(p, "03b-settings");
  // Cobalt fonts are local files (CSP: 'self' only) and really load: Space Grotesk / Inter / JetBrains Mono.
  r.fontsLoaded = await p.evaluate(async () => (await document.fonts.ready, [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")))].sort()));
  // Settings → Diagnostics: transfer logs on; the upload and download below are logged.
  r.diagOffByDefault = !(await p.isChecked("[data-ddn=diag-log]")) && (await p.isDisabled("[data-ddn=diag-names]"));
  await p.click("[data-ddn=diag-log]");
  await p.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-ddn=diag-names]")!.disabled, null, { timeout: 10_000 });
  r.diagOn = await p.textContent("[data-ddn=diag-state]");
  // Settings → Network & transfers: its own section (not under Diagnostics) with save data, the guard and
  // pieces in flight. Automatic by default (measured, starts at 4), a value applies at once.
  r.netSection = await p.evaluate(() => {
    const sec = document.querySelector("[data-ddn=net-sec]");
    const diag = document.getElementById("diagnostics");
    return { visible: !!sec && !(sec as HTMLElement).hidden, save: !!sec?.querySelector("[data-ddn=net-savedata]"), guard: !!sec?.querySelector("[data-ddn=net-guard]"), conc: !!sec?.querySelector("[data-ddn=diag-conc-up]"), notInDiag: !diag?.querySelector("[data-ddn=net-savedata]"), title: document.getElementById("net-h")?.textContent ?? "" };
  });
  await p.click("[data-ddn=diag-adv] summary");
  await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=diag-conc-now]")?.textContent ?? ""));
  r.concAuto = await p.getAttribute("[data-ddn=diag-conc-up]", "placeholder");
  await typeInto(p, "[data-ddn=diag-conc-down]", "6");
  await p.keyboard.press("Tab");
  await p.waitForFunction(() => /6/.test(document.querySelector("[data-ddn=diag-conc-now]")?.textContent ?? ""));
  r.concSet = await p.evaluate(async () => (window as unknown as { ddnCore: { concurrency(): Promise<{ upload: number; download: number }> } }).ddnCore.concurrency());
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
      const w = window as unknown as { __progress(s: string): void };
      for (const li of q.querySelectorAll("[data-ddn=queue-item]")) {
        w.__progress(`${li.firstElementChild?.textContent}:${li.querySelector(".qstate")?.textContent}`);
        const sp = li.querySelector("[data-ddn=queue-speed]")?.textContent;
        if (sp) w.__progress(`${li.firstElementChild?.textContent}:speed${sp}`);
      }
      const meta = document.querySelector("[data-ddn=queue-meta]")?.textContent;
      if (meta) w.__progress(`meta:${meta}`);
    }).observe(document.querySelector("[data-ddn-ui=queue]")!, { childList: true, characterData: true, subtree: true });
  });
  await p.setInputFiles("[data-ddn=file]", [doc, video, big]);
  await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 300_000 });
  await count(p, L.four);
  r.docSize = await p.locator("[data-ddn=row]", { hasText: "notatki.txt" }).locator(".size").textContent();
  r.queueNote = await p.textContent("[data-ddn-ui=queue] > .hint");
  const bigSteps = [...new Set(progress.filter((x) => x.startsWith("duzy.bin:") && /%$/.test(x)))];
  r.progressBigFile = bigSteps;
  // Live speed: the file's line ends with the average and the time ("avg 3.1 MB/s · 4 s"), the batch line too.
  r.uploadSpeed = { file: progress.filter((x) => x.startsWith("duzy.bin:speed")).at(-1) ?? null, meta: progress.filter((x) => x.startsWith("meta:") && /MB\/s/.test(x)).at(-1) ?? null };
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
  // 12 MiB > streamMinBytes (1 MiB here): saved through the service worker stream, not a Blob.
  r.downloadStreamed = (await p.$$eval("[data-ddn=dl-frame]", (e) => e.map((f) => (f as HTMLIFrameElement).src))).some((u) => u.includes("/ddn/download/"));
  // The downloads panel: the file, done, its average speed (the same look as the upload queue).
  r.downloadPanel = await p.evaluate(() => {
    const li = document.querySelector("[data-ddn=dl-item]");
    return { shown: !document.querySelector("[data-ddn=downloads]")!.hasAttribute("hidden"), name: li?.querySelector(".qname")?.textContent ?? null, state: (li as HTMLElement | null)?.dataset.state ?? null, speed: li?.querySelector("[data-ddn=dl-speed]")?.textContent ?? null, bar: (li?.querySelector(".bar > i") as HTMLElement | null)?.style.width ?? null };
  });
  // Download the transfer log (Settings → Diagnostics), check it and run the report on it.
  {
    await nav(p, "settings");
    await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=diag-info]")?.textContent ?? ""), null, { timeout: 10_000 });
    const [lf] = await Promise.all([p.waitForEvent("download", { timeout: 30_000 }), p.click("[data-ddn=diag-download]")]);
    const raw = readFileSync((await lf.path())!);
    const text = (raw[0] === 0x1f && raw[1] === 0x8b ? (await import("node:zlib")).gunzipSync(raw) : raw).toString("utf8");
    const { parseLines, buildReport } = await import("@ddv4/metadata-client/transfer-report");
    const { events, bad } = parseLines(text);
    const tokens = hookUrls.map((u) => u.split("/").at(-1)!);
    const rep = buildReport(events, { bucketS: 5 });
    const fileOf = (src: string, dir: string) => events.find((e) => e.ev === "file_end" && e.src === src && e.dir === dir && e.size === 12 * 1024 * 1024);
    r.transferLog = {
      file: lf.suggestedFilename(),
      lines: events.length,
      bad,
      noSecrets: !tokens.some((x) => text.includes(x)) && !/duzy\.bin|notatki|klip\.webm|[?&](ex|hm)=|\/webhooks\/\d+\/[\w.-]{20,}/.test(text),
      upEnd: !!fileOf("web", "up")?.ok,
      downEnd: !!fileOf("web", "down")?.ok,
      ext: events.find((e) => e.ev === "file_start" && e.dir === "up" && e.size === 12 * 1024 * 1024)?.ext ?? null,
      fragsUp: events.filter((e) => e.ev === "frag" && e.src === "web" && e.dir === "up" && e.x === fileOf("web", "up")?.x).length,
      reqsDown: events.filter((e) => e.ev === "req" && e.src === "web" && e.dir === "down").length,
      // e2ee/plain: the instance's part for this account is in the same file.
      serverLines: events.filter((e) => e.src === "server").length,
      serverPosts: events.filter((e) => e.src === "server" && e.ev === "req" && e.k === "discord").length,
      report: { files: rep.summary.files, n429: rep.summary.rateLimits.n429, stages: Object.keys(rep.summary.stages) },
    };
    // Clear (owner, 2026-10-15: "Clear removes only today's lines, the old ones stay"): an old part that
    // another tab keeps open cannot be removed, so Clear must still leave its older lines out of the download.
    {
      // A part from an "earlier session", held open by another worker (like a forgotten tab from
      // yesterday; sync access handles exist only in workers, exactly as the app writes its log).
      // The worker file goes only into this check's own copy of dist (CSP: worker-src 'self').
      writeFileSync(
        join(dist, "test-hold-log.js"),
        `(async () => {
          const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("ddn-transfer-logs", { create: true });
          const f = await d.getFileHandle("2000-01-01T00-00-00-000Z-old000-000.jsonl", { create: true });
          const h = await f.createSyncAccessHandle();
          h.write(new TextEncoder().encode('{"v":1,"t":946684800000,"src":"web","ev":"file_start","dir":"up","x":"OLDSESSION","size":1,"n":1}\\n'), { at: 0 });
          h.flush();
          self.__h = h; // stays open: the browser refuses removeEntry on it
          postMessage("open");
        })().catch((e) => postMessage("err " + e));`,
      );
      await p.evaluate(async () => {
        const w = new Worker("/test-hold-log.js");
        (globalThis as { __oldWorker?: Worker }).__oldWorker = w;
        const m = await new Promise<string>((res) => (w.onmessage = (e) => res(String(e.data))));
        if (m !== "open") throw new Error(m);
      });
      await p.click("[data-ddn=diag-clear]");
      await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /cleared|Wyczyszczono/i.test(t.textContent ?? "")), null, { timeout: 15_000 });
      const toastText = (await p.locator(".toast", { hasText: /cleared|Wyczyszczono/i }).last().textContent()) ?? "";
      // Nothing logged since the clear: the old part (still on disk, held open) must not count — the
      // download says "no entries" instead of giving yesterday's lines.
      const lines = await p.evaluate(async () => (await (window as unknown as { ddnCore: { transferLogFile(): Promise<{ lines: number }> } }).ddnCore.transferLogFile()).lines);
      await p.click("[data-ddn=diag-download]");
      const emptyToast = await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /No transfer|Brak wpis|empty|pusty/i.test(t.textContent ?? "")), null, { timeout: 15_000 }).then(() => true).catch(() => false);
      r.transferLogClear = { lines, emptyToast, toastSaysKept: /still open|otwartych/.test(toastText) };
      await p.evaluate(() => (globalThis as { __oldWorker?: Worker }).__oldWorker?.terminate());
    }
    await nav(p, "files");
  }

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
  // Settings → Storage: state + "Clean up now" (the 30-day windows cannot pass in a browser run; the
  // retention itself is covered by metadata-client cleanup.test.ts and server-discord e2ee-server.test.ts).
  await nav(p, "settings");
  await p.waitForFunction(() => (document.querySelector("[data-ddn=storage-last]")?.textContent ?? "") !== "");
  const st0 = { by: await p.textContent("[data-ddn=storage-state]"), last: await p.textContent("[data-ddn=storage-last]"), waiting: await p.textContent("[data-ddn=storage-waiting]") };
  await p.click("[data-ddn=cleanup-now]");
  await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=cleanup-result]")?.textContent ?? "") && !/not yet|jeszcze nie/.test(document.querySelector("[data-ddn=storage-last]")?.textContent ?? ""), null, { timeout: 60_000 });
  ops.storage = { before: st0, after: { last: await p.textContent("[data-ddn=storage-last]"), result: await p.textContent("[data-ddn=cleanup-result]"), waiting: await p.textContent("[data-ddn=storage-waiting]") } };
  await p.locator("#storage").scrollIntoViewIfNeeded();
  await shot(p, "18-settings-storage");
  // Settings → Security: password sign-in (off by default), then a fresh browser signs in with it.
  const pwLogin = `check.${Date.now().toString(36)}`;
  const pwPass = "check run passphrase 2026 long";
  ops.pwDefaultOff = /off|wyłączone/.test((await p.textContent("[data-ddn=pw-state]")) ?? "");
  await typeInto(p, "[data-ddn=pw-login]", pwLogin);
  await typeInto(p, "[data-ddn=pw-password]", pwPass);
  await p.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-ddn=pw-strength]")?.dataset.score) >= 3);
  ops.pwStrength = await p.textContent("[data-ddn-ui=pw-strength-t]");
  await typeInto(p, "[data-ddn=pw-password2]", pwPass);
  await p.click("[data-ddn=pw-save]");
  ops.pwNeedsAck = /risk|ryzyko/.test((await p.waitForSelector(".toast.err").then((e) => e.textContent())) ?? "");
  await p.check("[data-ddn=pw-ack]");
  await p.click("[data-ddn=pw-save]");
  await p.waitForFunction(() => /on|włączone/.test(document.querySelector("[data-ddn=pw-state]")?.textContent ?? "") && !/off|wyłączone/.test(document.querySelector("[data-ddn=pw-state]")?.textContent ?? ""), null, { timeout: 30_000 });
  await p.locator("#security").scrollIntoViewIfNeeded();
  await shot(p, "19-settings-security");
  const fresh = await browser.newContext({ colorScheme: SCHEME });
  await fresh.addInitScript({ content: `window.__name = (f) => f; try { localStorage.setItem("ddn.lang", ${JSON.stringify(LANG)}) } catch {}` });
  const np = await newPage(fresh);
  await np.goto(base);
  await np.waitForSelector("body[data-ready='1']");
  await np.click("[data-ddn=signin-open]");
  await np.waitForURL((u) => u.pathname === "/signin");
  await typeInto(np, "[data-ddn=signin-login]", pwLogin.toUpperCase());
  await typeInto(np, "[data-ddn=signin-password]", "not the password at all");
  await np.click("[data-ddn=signin-go]");
  ops.pwWrong = await np.waitForSelector(".toast.err").then((e) => e.textContent());
  await typeInto(np, "[data-ddn=signin-password]", pwPass);
  await typeInto(np, "[data-ddn=signin-name]", "Haslem");
  await shot(np, "20-signin-password");
  await np.click("[data-ddn=signin-go]");
  await count(np, L.of(65));
  ops.pwSignedIn = true;
  await fresh.close();
  // Turn it off again: the sealed key is deleted from the server.
  await p.click("[data-ddn=pw-off]");
  await p.waitForSelector("[data-ddn=confirm-dialog][open]");
  await p.click("[data-ddn=confirm-yes]");
  await p.waitForFunction(() => /off|wyłączone/.test(document.querySelector("[data-ddn=pw-state]")?.textContent ?? ""));
  ops.pwOff = true;
  r.ops = ops;

  // 10c. file preview in a new root folder "Podglad" (the counts above
  // are done): text, rendered Markdown without raw HTML, JSON, CSV table, JPEG, PDF, a hostile SVG; ←/→, Esc,
  // the row menu entry, quick → presses (only the last file renders), blob URLs revoked; phone viewport.
  step("preview");
  const pv: Record<string, unknown> = {};
  const pvDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-pv-"));
  writeFileSync(join(pvDir, "a.txt"), "Zażółć gęślą jaźń\nplain <b>text</b> line 2\n");
  writeFileSync(join(pvDir, "b.md"), "# Podgląd\n\nSome **bold** and *em* text.\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror=\"window.__pwned = 2\">\n\n[evil](javascript:window.__pwned=3) and [ok](https://example.com/)\n\n- one\n- two\n\n```\ncode <i>x</i>\n```\n");
  writeFileSync(join(pvDir, "c.json"), '{"name":"Podglad","list":[1,2,{"deep":true}],"n":12345678901234567890}');
  writeFileSync(join(pvDir, "d.csv"), 'city,note\r\nKraków,"comma, inside"\r\nGdańsk,"line\nbreak and ""quotes"""\r\n');
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1", join(pvDir, "e.jpg")]);
  writeFileSync(join(pvDir, "f.pdf"), (() => {
    const stream = "BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET";
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let out = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => ((offs.push(out.length)), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    return out;
  })());
  // Hostile SVG: a script, an onload handler and a remote image; shown as <img> none of it may run or load.
  writeFileSync(join(pvDir, "g.svg"), '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="30" onload="window.top.__pwned = 4"><script>window.top.__pwned = 5; parent.__pwned = 5;</script><rect width="40" height="30" fill="#c33"/><image xlink:href="https://evil.example/x.png" width="1" height="1"/></svg>');
  const pvNames = ["a.txt", "b.md", "c.json", "d.csv", "e.jpg", "f.pdf", "g.svg"];
  const pvId = await p.evaluate(async () => (window as unknown as { ddnCore: { mkdir(n: string): Promise<string> } }).ddnCore.mkdir("Podglad"));
  // Desktop browser with a PDF viewer (the headless shell has none: pdfViewerEnabled false), and a
  // record of every blob URL (type, revoked) to check the Content-Types and the cleanup.
  await p.addInitScript({
    content: `Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { get: () => true, configurable: true });
      window.__blobs = {}; const _c = URL.createObjectURL.bind(URL), _r = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = _c(b); window.__blobs[u] = { type: b.type, revoked: false }; return u; };
      URL.revokeObjectURL = (u) => { if (window.__blobs[u]) window.__blobs[u].revoked = true; _r(u); };`,
  });
  await p.goto(`${base}/folder/${pvId}`);
  await p.waitForSelector("body[data-ready='1']");
  await p.waitForFunction(() => document.querySelector("[data-ddn-ui=folder-title]")?.textContent === "Podglad");
  await p.setInputFiles("[data-ddn=file]", pvNames.map((n) => join(pvDir, n)));
  await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 120_000 });
  await count(p, /^7 /);
  const pvReady = async (pg: Page, name: string) => {
    await pg.waitForSelector(`[data-ddn=preview-dialog][open][data-file="${name}"][data-state=ready]`, { timeout: 60_000 });
    // Remember the blob URLs the preview shows (checked for revocation at the end).
    await pg.evaluate(() => {
      const w = window as unknown as { __pvUrls?: string[] };
      w.__pvUrls = [...(w.__pvUrls ?? []), ...[...document.querySelectorAll<HTMLImageElement | HTMLIFrameElement>("[data-ddn=preview-body] img, [data-ddn=preview-body] iframe")].map((e) => e.src).filter((u) => u.startsWith("blob:"))];
    });
  };
  // Click the row (its name), not a button: the preview opens.
  await p.locator("[data-ddn=row]", { hasText: "a.txt" }).locator("[data-ddn=preview-open]").click();
  await pvReady(p, "a.txt");
  pv.text = (await p.textContent("[data-ddn=preview-text]")) === "Zażółć gęślą jaźń\nplain <b>text</b> line 2\n";
  pv.prevDisabledAtFirst = await p.isDisabled("[data-ddn=preview-prev]");
  await shot(p, "21-preview-text");
  await p.keyboard.press("ArrowRight");
  await pvReady(p, "b.md");
  pv.md = await p.evaluate(() => {
    const a = document.querySelector("[data-ddn=preview-md]")!;
    return {
      h1: a.querySelector("h1")?.textContent,
      strong: a.querySelector("strong")?.textContent,
      li: a.querySelectorAll("li").length,
      noScript: !document.querySelector("[data-ddn=preview-dialog] script"),
      noImg: a.querySelectorAll("img, iframe, object, embed, svg").length === 0,
      noHandlers: [...a.querySelectorAll("*")].every((e) => ![...e.attributes].some((x) => /^on/i.test(x.name))),
      noJsHref: [...a.querySelectorAll("a")].every((x) => /^(https?|mailto):/.test(x.getAttribute("href") ?? "")),
      ok: [...a.querySelectorAll("a")].map((x) => [x.getAttribute("href"), x.getAttribute("rel"), x.getAttribute("target")]),
      rawShownAsText: (a.textContent ?? "").includes("<script>window.__pwned = 1</script>") && (a.textContent ?? "").includes("onerror"),
      evilAsText: (a.textContent ?? "").includes("evil"),
      pwned: (window as unknown as { __pwned?: unknown }).__pwned ?? null,
    };
  });
  await shot(p, "21b-preview-markdown");
  await p.keyboard.press("ArrowRight");
  await pvReady(p, "c.json");
  pv.json = (await p.textContent("[data-ddn=preview-text]")) === '{\n  "name": "Podglad",\n  "list": [\n    1,\n    2,\n    {\n      "deep": true\n    }\n  ],\n  "n": 12345678901234567890\n}';
  await p.click("[data-ddn=preview-next]"); // the on-screen arrow
  await pvReady(p, "d.csv");
  pv.csv = await p.$$eval("[data-ddn=preview-table] tr", (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  await shot(p, "21c-preview-csv");
  await p.keyboard.press("ArrowRight");
  await pvReady(p, "e.jpg");
  pv.jpg = await p.$eval("[data-ddn=preview-img]", (i) => ({ w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight, src: (i as HTMLImageElement).src.slice(0, 5), type: (window as unknown as { __blobs: Record<string, { type: string }> }).__blobs[(i as HTMLImageElement).src]?.type }));
  await shot(p, "21d-preview-jpg");
  await p.keyboard.press("ArrowRight");
  await pvReady(p, "f.pdf");
  pv.pdf = await p.$eval("[data-ddn=preview-pdf]", (f) => ({ tag: f.tagName, src: (f as HTMLIFrameElement).src.slice(0, 5), type: (window as unknown as { __blobs: Record<string, { type: string }> }).__blobs[(f as HTMLIFrameElement).src]?.type, sandbox: f.getAttribute("sandbox") }));
  await shot(p, "21e-preview-pdf");
  await p.keyboard.press("ArrowRight");
  await pvReady(p, "g.svg");
  await p.waitForTimeout(500);
  pv.svg = await p.evaluate(() => {
    const i = document.querySelector<HTMLImageElement>("[data-ddn=preview-img]")!;
    return { tag: i.tagName, w: i.naturalWidth, src: i.src.slice(0, 5), type: (window as unknown as { __blobs: Record<string, { type: string }> }).__blobs[i.src]?.type, inline: !!document.querySelector("[data-ddn=preview-body] svg, [data-ddn=preview-body] iframe, [data-ddn=preview-body] object"), pwned: (window as unknown as { __pwned?: unknown }).__pwned ?? null };
  });
  await shot(p, "21f-preview-svg");
  pv.nextDisabledAtLast = await p.isDisabled("[data-ddn=preview-next]");
  await p.keyboard.press("ArrowRight"); // nothing after the last file
  await p.waitForTimeout(300);
  pv.staysAtLast = (await p.getAttribute("[data-ddn=preview-dialog]", "data-file")) === "g.svg";
  await p.keyboard.press("ArrowLeft");
  await pvReady(p, "f.pdf");
  pv.arrowLeft = true;
  await p.keyboard.press("Escape");
  await p.waitForSelector("[data-ddn=preview-dialog][open]", { state: "detached" });
  pv.escapeCloses = true;
  // The row menu entry, then several quick → presses: only the last requested file renders.
  await p.locator("[data-ddn=row]", { hasText: "a.txt" }).locator("[data-ddn=row-more]").click();
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])");
  await p.click("[data-ddn=menu-preview]");
  await pvReady(p, "a.txt");
  for (let k = 0; k < 4; k++) await p.keyboard.press("ArrowRight");
  await pvReady(p, "e.jpg");
  await p.waitForTimeout(800);
  pv.quickArrows = await p.evaluate(() => ({ file: document.querySelector("[data-ddn=preview-dialog]")?.getAttribute("data-file"), bodyKids: document.querySelector("[data-ddn=preview-body]")!.children.length, img: !!document.querySelector("[data-ddn=preview-img]") }));
  await p.keyboard.press("Escape");
  await p.waitForSelector("[data-ddn=preview-dialog][open]", { state: "detached" });
  // The dialog's "close" event (which revokes) comes in a task after [open] is gone: give it a moment;
  // a real leak still shows as open > 0 after it.
  await p
    .waitForFunction(() => {
      const w = window as unknown as { __blobs: Record<string, { revoked: boolean }>; __pvUrls?: string[] };
      return (w.__pvUrls ?? []).every((u) => w.__blobs[u]?.revoked);
    }, null, { timeout: 3000 })
    .catch(() => {});
  pv.blobsRevoked = await p.evaluate(() => {
    const w = window as unknown as { __blobs: Record<string, { revoked: boolean; type?: string }>; __pvUrls?: string[] };
    const shown = [...new Set(w.__pvUrls ?? [])];
    return { shown: shown.length, open: shown.filter((u) => !w.__blobs[u]?.revoked).length, openTypes: shown.filter((u) => !w.__blobs[u]?.revoked).map((u) => w.__blobs[u]?.type ?? "?") };
  });
  pv.pwned = await p.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned ?? null);
  // Phone (the paired device): full-screen preview, no horizontal scroll, arrows on screen; PDF -> Download.
  await m.goto(`${base}/folder/${pvId}`);
  await m.waitForSelector("body[data-ready='1']");
  await count(m, /^7 /);
  await m.locator("[data-ddn=row]", { hasText: "d.csv" }).locator("[data-ddn=preview-open]").click();
  await pvReady(m, "d.csv");
  pv.phone = await m.evaluate(() => {
    const d = document.querySelector<HTMLElement>("[data-ddn=preview-dialog]")!;
    const inView = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    };
    return { noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1 && d.scrollWidth <= d.clientWidth + 1, full: Math.abs(d.getBoundingClientRect().width - window.innerWidth) <= 1, arrows: inView("[data-ddn=preview-prev]") && inView("[data-ddn=preview-next]") && inView("[data-ddn=preview-close]") && inView("[data-ddn=preview-download]") };
  });
  await shot(m, "22-phone-preview");
  await m.click("[data-ddn=preview-next]");
  await m.click("[data-ddn=preview-next]");
  await pvReady(m, "f.pdf");
  pv.phonePdf = { message: await m.isVisible("[data-ddn=preview-msg] [data-ddn=preview-download-msg]"), noFrame: !(await m.$("[data-ddn=preview-pdf]")) };
  await shot(m, "22b-phone-pdf");
  const [pdl] = await Promise.all([m.waitForEvent("download", { timeout: 60_000 }), m.click("[data-ddn=preview-download-msg]")]);
  (pv.phonePdf as Record<string, unknown>).download = pdl.suggestedFilename() === "f.pdf" && sha(readFileSync((await pdl.path())!)) === sha(readFileSync(join(pvDir, "f.pdf")));
  await m.keyboard.press("Escape");
  r.preview = pv;

  // 10c'. In "Podglad": Move to trash next to Download (+ Undo), the context menu on
  // the empty area (New folder) and on a file (Rename), Shift+F10 / arrows / Esc with focus back, the sort
  // (folders first, remembered), List / Tiles (remembered after a reload), tiles on the phone with a long
  // press, the trash's own menu (Restore).
  step("context menu, tiles");
  const cm: Record<string, unknown> = {};
  await p.goto(`${base}/folder/${pvId}`);
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /^7 /);
  const rowOf = (pg: Page, name: string) => pg.locator("[data-ddn=row]", { hasText: name });
  cm.trashNextToDownload = await rowOf(p, "g.svg").evaluate((tr) => {
    const dl = tr.querySelector("[data-ddn=download]");
    const tb = tr.querySelector<HTMLElement>("[data-ddn=row-trash]");
    return !!dl && dl.nextElementSibling === tb && !!tb && tb.offsetParent !== null && /trash|kosz/i.test(tb.getAttribute("aria-label") ?? "") && !!tb.title;
  });
  cm.folderRowHasTrash = true;
  await rowOf(p, "g.svg").locator("[data-ddn=row-trash]").click();
  await count(p, /^6 /);
  cm.trashNoConfirm = !(await p.isVisible("[data-ddn=confirm-dialog][open]"));
  await p.locator("[data-ddn=toast-undo]").last().click();
  await count(p, /^7 /);
  cm.trashUndo = true;
  // Right click on the empty area (the page head): New folder, Upload, Select all, View, Sort, Refresh.
  await p.click("[data-ddn-ui=folder-title]", { button: "right" });
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=files]");
  cm.areaItems = await p.$$eval("[data-ddn=row-menu] button", (b) => b.map((x) => x.getAttribute("data-ddn")));
  await shot(p, "23-context-area");
  await p.click("[data-ddn=menu-new-folder]");
  await p.waitForSelector("[data-ddn=folder-dialog][open]");
  await p.keyboard.type("Z menu", { delay: 2 });
  await p.keyboard.press("Enter");
  await count(p, /^8 /);
  cm.newFolderFirst = (await p.$$eval("[data-ddn=row]", (e) => e.map((x) => x.getAttribute("data-kind"))))[0] === "folder" && (await p.textContent("[data-ddn=row] .nm > :last-child")) === "Z menu";
  cm.folderRowHasTrash = (await rowOf(p, "Z menu").locator("[data-ddn=row-trash]").count()) === 1;
  // Right click on a file: the row's actions; Rename.
  await rowOf(p, "c.json").locator("[data-ddn=preview-open]").click({ button: "right" });
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=row]");
  cm.rowItems = await p.$$eval("[data-ddn=row-menu] button", (b) => b.map((x) => x.getAttribute("data-ddn")));
  cm.rightClickNoPreview = !(await p.isVisible("[data-ddn=preview-dialog][open]"));
  await shot(p, "24-context-row");
  await p.click("[data-ddn=menu-rename]");
  await p.waitForSelector("[data-ddn=rename-dialog][open]");
  await typeInto(p, "[data-ddn=rename-name]", "c2.json");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=row] .nm > :last-child")].some((x) => x.textContent === "c2.json"), null, { timeout: 30_000 });
  cm.renamedFromContext = true;
  // Keyboard: Shift+F10 on the focused file name, arrows, Esc; the focus comes back.
  await rowOf(p, "a.txt").locator("[data-ddn=preview-open]").focus();
  await p.keyboard.press("Shift+F10");
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=row]");
  const f0 = await p.evaluate(() => document.activeElement?.getAttribute("data-ddn"));
  await p.keyboard.press("ArrowDown");
  const f1 = await p.evaluate(() => document.activeElement?.getAttribute("data-ddn"));
  await p.keyboard.press("End");
  const f2 = await p.evaluate(() => document.activeElement?.getAttribute("data-ddn"));
  await p.keyboard.press("Escape");
  await p.waitForSelector("[data-ddn=row-menu][hidden]", { state: "attached" });
  cm.keyboard = { first: f0, down: f1, end: f2, back: await p.evaluate(() => document.activeElement?.closest("[data-ddn=row]")?.querySelector(".nm > :last-child")?.textContent === "a.txt" && document.activeElement?.getAttribute("data-ddn") === "preview-open"), previewClosed: !(await p.isVisible("[data-ddn=preview-dialog][open]")) };
  // Sort by size from the column head (biggest first; folders stay first), remembered after a reload.
  await p.click("[data-ddn=sort][data-sort=size]");
  const sized = async () =>
    p.$$eval("[data-ddn=row]", (rows) => rows.map((x) => ({ k: x.getAttribute("data-kind"), n: x.querySelector(".nm > :last-child")?.textContent ?? "" })));
  await p.waitForFunction(() => document.querySelector("[data-ddn=sort][data-sort=size]")?.closest("th")?.getAttribute("aria-sort") === "descending");
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=row]")[1]?.querySelector(".nm > :last-child")?.textContent === "f.pdf" || document.querySelectorAll("[data-ddn=row]")[1]?.querySelector(".nm > :last-child")?.textContent === "e.jpg");
  const sizes = Object.fromEntries(pvNames.map((n) => [n === "c.json" ? "c2.json" : n, statSync(join(pvDir, n)).size]));
  const bySize = await sized();
  cm.sortSize = bySize[0]!.k === "folder" && bySize.slice(1).every((x, i, a) => i === 0 || sizes[a[i - 1]!.n]! >= sizes[x.n]!);
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /^8 /);
  cm.sortKept = JSON.stringify(await sized()) === JSON.stringify(bySize);
  await p.click("[data-ddn=sort][data-sort=name]");
  await p.waitForFunction(() => document.querySelectorAll("[data-ddn=row]")[1]?.querySelector(".nm > :last-child")?.textContent === "a.txt");
  // List -> Tiles from the head switch; kept after a reload; back to List from the context menu.
  await p.click("[data-ddn=view] [data-view=tiles]");
  const tilesNow = (pg: Page) =>
    pg.evaluate(() => {
      const w = document.querySelector<HTMLElement>("[data-page=files] .ftable-wrap")!;
      const tb = w.querySelector("tbody")!;
      return { view: w.dataset.view, grid: getComputedStyle(tb).display === "grid", cols: getComputedStyle(tb).gridTemplateColumns.split(" ").length, pressed: document.querySelector("[data-page=files] [data-ddn=view] [aria-pressed=true]")?.getAttribute("data-view") };
    });
  cm.tiles = await tilesNow(p);
  await shot(p, "25-tiles");
  await p.reload();
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /^8 /);
  cm.tilesKept = await tilesNow(p);
  await p.click("[data-ddn-ui=folder-title]", { button: "right" });
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=files]");
  cm.viewChecked = await p.getAttribute("[data-ddn=menu-view-tiles]", "aria-checked");
  await p.click("[data-ddn=menu-view-list]");
  cm.listAgain = (await tilesNow(p)).view === "list";
  // Phone (the paired device): Tiles, long press on a tile = the row menu (no preview), trash visible.
  await m.goto(`${base}/folder/${pvId}`);
  await m.waitForSelector("body[data-ready='1']");
  await count(m, /^8 /);
  await m.click("[data-ddn=view] [data-view=tiles]");
  const mt = await tilesNow(m);
  const tile = rowOf(m, "d.csv");
  const box = (await tile.boundingBox())!;
  const touch = await m.context().newCDPSession(m);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await m.waitForTimeout(800);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // 15 s: under two parallel runs the 5 s wait once missed the menu (frontend note 3, 2026-10-14)
  await m.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=row]", { timeout: 15000 });
  await m.waitForTimeout(300);
  cm.phone = {
    ...mt,
    noHScroll: await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    longPress: (await m.$$eval("[data-ddn=row-menu] button", (b) => b.map((x) => x.getAttribute("data-ddn")))).includes("menu-rename"),
    noPreview: !(await m.isVisible("[data-ddn=preview-dialog][open]")),
    trashShown: await tile.locator("[data-ddn=row-trash]").isVisible(),
  };
  await shot(m, "26-phone-tiles-menu");
  await m.keyboard.press("Escape");
  // Trash: its own menu on a row (Restore / Delete for good).
  await rowOf(p, "d.csv").locator("[data-ddn=row-trash]").click();
  await count(p, /^7 /);
  await nav(p, "trash" as never);
  await p.waitForSelector("[data-ddn=trash-row]");
  await p.locator("[data-ddn=trash-row]", { hasText: "d.csv" }).click({ button: "right" });
  await p.waitForSelector("[data-ddn=row-menu]:not([hidden])[data-for=trash-row]");
  cm.trashItems = await p.$$eval("[data-ddn=row-menu] button", (b) => b.map((x) => x.getAttribute("data-ddn")));
  await p.click("[data-ddn=menu-restore]");
  await p.waitForSelector("[data-ddn-ui=trash-none]:not([hidden])");
  cm.trashRestored = true;
  // A text field keeps the browser's own menu.
  await nav(p, "settings");
  await p.waitForSelector("[data-ddn=pw-login]");
  await p.click("[data-ddn=pw-login]", { button: "right" });
  await p.waitForTimeout(200);
  cm.nativeInInputs = await p.isHidden("[data-ddn=row-menu]");
  await p.keyboard.press("Escape");
  await nav(p, "files");
  r.contextMenu = cm;

  // 10c'''. The network goes away mid-download (context.setOffline): the panel
  // says "waiting for the network" (no error); it comes back: "resumed", the file completes with the right
  // SHA-256. The second connection (sandboxed iframe lane) downloads a file with Origin: null. Save data and
  // the stuck-connection switch in Settings > Diagnostics. An upload broken by a reload continues: only the
  // missing pieces are sent.
  step("network");
  {
    const nw: Record<string, any> = {};
    r.network = nw; // filled as it goes (a failure shows how far it got)
    const core = (fn: string, ...a: unknown[]) => p.evaluate(([f, args]) => (window as unknown as { ddnCore: Record<string, (...x: unknown[]) => Promise<unknown>> }).ddnCore[f as string]!(...(args as unknown[])), [fn, a] as const);
    // Own folder and file (earlier steps moved things around): 3 fragments of 10 MiB + a bit.
    const nDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-net-"));
    const netFile = join(nDir, "siec.bin");
    writeFileSync(netFile, (await import("node:crypto")).randomBytes(2 * 10 * 1024 * 1024 + 4096));
    const nFolder = await core("mkdir", "Siec");
    await p.goto(`${base}/folder/${nFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    await p.setInputFiles("[data-ddn=file]", [netFile]);
    await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 120_000 });
    await p.waitForSelector("[data-ddn=row]");
    const netRow = () => p.locator("[data-ddn=row]", { hasText: "siec.bin" }).first().locator("[data-ddn=download]");
    // The lane iframe is there and attached (2 connections).
    await p.waitForFunction(() => !!document.querySelector("iframe[data-ddn=lane-frame][sandbox='allow-scripts']"));
    nw.lanes = await p
      .waitForFunction(async () => ((await (window as unknown as { ddnCore: { netStatus(): Promise<{ lanes: number }> } }).ddnCore.netStatus()).lanes === 2 ? 2 : 0), null, { timeout: 15_000, polling: 200 })
      .then(() => 2)
      .catch(() => 1);
    // Download over the second connection (as after a switch by the guard): CDN reads with Origin: null.
    fake?.cdnOriginsSeen.clear();
    await core("netUseLane", 1);
    const [d1] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), netRow().click()]);
    nw.laneSha = sha(readFileSync((await d1.path())!)) === sha(readFileSync(netFile));
    nw.laneOrigins = fake ? [...fake.cdnOriginsSeen] : null;
    await core("netUseLane", 0);
    // Offline in the middle of a download: a slow CDN, so it is still running when the network goes.
    if (fake) fake.cdnDelayMs = 1500;
    const dlP = Promise.all([p.waitForEvent("download", { timeout: 180_000 }), netRow().click()]);
    await p.waitForSelector("[data-ddn=dl-item][data-state]:not([data-state=done]), [data-ddn=dl-item]:not([data-state])", { timeout: 30_000 });
    await p.waitForTimeout(300);
    await ctx.setOffline(true);
    await p.waitForSelector("[data-ddn=dl-net]:not([hidden])[data-state=offline]", { timeout: 30_000 });
    nw.offlineText = await p.textContent("[data-ddn=dl-net]");
    await p.waitForTimeout(3000);
    nw.noErrorWhileOffline = (await p.locator("[data-ddn=dl-item][data-state=err]").count()) === 0;
    await shot(p, "30-waiting-for-network");
    await ctx.setOffline(false);
    nw.resumedShown = await p.waitForSelector("[data-ddn=dl-net][data-state=resumed]", { timeout: 30_000 }).then(() => true).catch(() => false);
    if (fake) fake.cdnDelayMs = 0;
    const [d2] = await dlP;
    nw.offlineSha = sha(readFileSync((await d2.path())!)) === sha(readFileSync(netFile));
    // Settings > Diagnostics: Save data on = 2 at once, stuck-connection switch off; both remembered.
    await nav(p, "settings");
    await p.click("[data-ddn=diag-adv] summary");
    await p.waitForSelector("[data-ddn=net-guard]");
    nw.guardDefault = await p.isChecked("[data-ddn=net-guard]");
    await p.uncheck("[data-ddn=net-guard]");
    await p.check("[data-ddn=net-savedata]");
    await p.waitForTimeout(300);
    nw.guardDisabledBySaveData = await p.isDisabled("[data-ddn=net-guard]");
    const st1 = (await core("netStatus")) as { saveData: boolean; guard: boolean; metered: boolean; window: { upMax: number; downMax: number } };
    nw.saveData = { on: st1.saveData && st1.metered, upMax: st1.window.upMax, downMax: st1.window.downMax, guard: st1.guard };
    nw.chip = await p.textContent("[data-ddn=net-state]");
    nw.concNow = await p.textContent("[data-ddn=diag-conc-now]");
    // With save data on, the download panel says so (reason + link to the setting).
    await p.goto(`${base}/folder/${nFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    const [d4] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), netRow().click()]);
    await d4.path();
    nw.leanPanel = await p.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-ddn=dl-lean]");
      return { shown: !!el && !el.hidden, text: el?.textContent ?? "", why: el?.dataset.why ?? "", href: el?.querySelector("a")?.getAttribute("href") ?? "" };
    });
    await shot(p, "32-save-data-panel");
    await nav(p, "settings");
    await p.reload();
    await p.waitForSelector("body[data-ready='1']");
    const st2 = (await core("netStatus")) as { saveData: boolean; guard: boolean };
    nw.kept = st2.saveData === true && st2.guard === false;
    await nav(p, "settings");
    await p.click("[data-ddn=diag-adv] summary");
    await p.uncheck("[data-ddn=net-savedata]");
    await p.waitForSelector("[data-ddn=net-guard]:enabled");
    await p.check("[data-ddn=net-guard]");
    await p.waitForTimeout(300);
    const st3 = (await core("netStatus")) as { saveData: boolean; guard: boolean; window: { downMax: number } };
    nw.back = st3.saveData === false && st3.guard === true && st3.window.downMax > 2;
    nw.leanGone = await p.evaluate(() => document.querySelector<HTMLElement>("[data-ddn=dl-lean]")!.hidden);
    nw.info = await p.textContent("[data-ddn=net-info]");
    // Resume an upload after a reload: slow posts, the tab reloads mid-upload, the same file again.
    if (fake && !remote) {
      await p.goto(`${base}/folder/${nFolder}`);
      await p.waitForSelector("body[data-ready='1']");
      const rDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-resume-"));
      const rFile = join(rDir, "wznow.bin");
      writeFileSync(rFile, (await import("node:crypto")).randomBytes(3 * 10 * 1024 * 1024 + 4096)); // 4 fragments of 10 MiB
      const posts0 = fake.posts;
      fake.postDelayMs = 1500;
      await core("setConcurrency", 1, null);
      await p.setInputFiles("[data-ddn=file]", [rFile]);
      const until = Date.now() + 90_000;
      while (fake.posts - posts0 < 2 && Date.now() < until) await p.waitForTimeout(100);
      await p.waitForTimeout(400);
      nw.sentBefore = fake.posts - posts0;
      await p.reload(); // the tab "breaks" mid-upload
      await p.waitForSelector("body[data-ready='1']");
      fake.postDelayMs = 0;
      nw.unfinishedShown = await p.waitForSelector("[data-ddn=unfinished]:not([hidden])", { timeout: 15_000 }).then(() => true).catch(() => false);
      nw.unfinishedText = await p.textContent("[data-ddn=unfinished-list]");
      await shot(p, "31-unfinished-upload");
      const posts1 = fake.posts;
      await p.setInputFiles("[data-ddn=file]", [rFile]);
      await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 120_000 });
      nw.sentAfter = fake.posts - posts1;
      nw.title = await p.getAttribute("[data-ddn-ui=queue-list] li:last-child .qstate", "title");
      nw.unfinishedGone = await p.waitForSelector("[data-ddn=unfinished]", { state: "hidden", timeout: 10_000 }).then(() => true).catch(() => false);
      await core("setConcurrency", null, null);
      await p.waitForSelector("[data-ddn=row]:has-text('wznow.bin')", { timeout: 30_000 }).catch(() => {});
      nw.rowsAfter = await p.$$eval("[data-ddn=row]", (e) => e.map((x) => x.textContent?.slice(0, 30)));
      const [d3] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), p.locator("[data-ddn=row]", { hasText: "wznow.bin" }).first().locator("[data-ddn=download]").click()]);
      nw.resumeSha = sha(readFileSync((await d3.path())!)) === sha(readFileSync(rFile));
    }
    r.network = nw;
  }

  // 10c''. The upload panel closes itself (~5 s after success, later after a
  // failure; hover pauses it) and a failed file stays listed (Details, Retry) after it closed.
  step("queue closes");
  const qc: Record<string, unknown> = {};
  await p.goto(`${base}/folder/${pvId}`);
  await p.waitForSelector("body[data-ready='1']");
  await count(p, /^8 /);
  const qDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-q-"));
  writeFileSync(join(qDir, "q1.txt"), "queue closes\n");
  writeFileSync(join(qDir, "q2.txt"), "hover pauses\n");
  const queueShown = () => p.isVisible("[data-ddn-ui=queue]");
  const uploadDone = async (name: string) => {
    await p.setInputFiles("[data-ddn=file]", [join(qDir, name)]);
    await p.waitForFunction(() => !!document.querySelector("[data-ddn-ui=queue][data-closing]"), null, { timeout: 60_000 });
    return Date.now();
  };
  // Success: gone after ~5 s by itself.
  let t0 = await uploadDone("q1.txt");
  await p.mouse.move(5, 5);
  await p.waitForSelector("[data-ddn-ui=queue]", { state: "hidden", timeout: 15_000 });
  qc.okClosedMs = Date.now() - t0;
  // Hover pauses: still there after 7 s with the pointer on it, gone after it leaves.
  t0 = await uploadDone("q2.txt");
  await p.hover("[data-ddn-ui=queue-title]");
  await p.waitForTimeout(7000);
  qc.hoverKeeps = (await queueShown()) && (await p.getAttribute("[data-ddn-ui=queue]", "data-paused")) === "1";
  await p.mouse.move(5, 5);
  await p.waitForSelector("[data-ddn-ui=queue]", { state: "hidden", timeout: 15_000 });
  qc.closedAfterLeave = true;
  // Failure (a NUL in the name is refused before anything is sent): stays longer, the failed bar remains.
  await p.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("[data-ddn=file]")!;
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "bad\u0000name.txt"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  });
  await p.waitForFunction(() => !!document.querySelector("[data-ddn-ui=queue][data-closing]"), null, { timeout: 60_000 });
  t0 = Date.now();
  await p.mouse.move(5, 5);
  await p.waitForTimeout(7000);
  qc.errStillShownAt7s = await queueShown();
  qc.failedBar = { shown: await p.isVisible("[data-ddn=upload-failed]"), count: await p.textContent("[data-ddn=upload-failed-count]") };
  await p.waitForSelector("[data-ddn-ui=queue]", { state: "hidden", timeout: 15_000 });
  qc.errClosedMs = Date.now() - t0;
  qc.failedBarAfter = await p.isVisible("[data-ddn=upload-failed]");
  await p.click("[data-ddn=upload-failed-show]");
  qc.failedItem = await p.textContent("[data-ddn=upload-failed-item] .n");
  await shot(p, "27-upload-failed");
  // Retry runs it again (it fails again: the name is still invalid), the bar comes back with the file.
  await p.click("[data-ddn=upload-retry]");
  await p.waitForSelector("[data-ddn-ui=queue]:not([hidden])");
  await p.waitForFunction(() => !document.querySelector("[data-ddn=upload-failed]")!.hasAttribute("hidden"), null, { timeout: 60_000 });
  qc.retried = (await p.locator("[data-ddn=upload-failed-item]").count()) === 1;
  // × closes at once; dismiss clears the bar.
  await p.click("[data-ddn-ui=queue-close]");
  qc.xCloses = !(await queueShown());
  await p.click("[data-ddn=upload-failed-close]");
  qc.dismissed = await p.isHidden("[data-ddn=upload-failed]");
  await count(p, /^10 /);
  r.queueCloses = qc;


  // 10d. channels: the section folds (folded with channels, the
  // choice kept), per-channel stats, the remove dialog (impact list, options), retire + undo, a critical
  // channel offers only "move", remove anyway -> files unavailable: hidden by default, shown + explained
  // with the Settings switch, Storage totals count them; pasting the same webhook again brings them back;
  // move and remove (metadata only: in this tab; e2ee/plain: the instance job) -> files still download.
  step("channels");
  const ch: Record<string, unknown> = {};
  const extraHook = SERVER_SIDE ? hookUrls[0] : hookUrls[2];
  if (extraHook) {
    // Forget the fold choice the earlier steps made (they opened the section), as on a first visit.
    await p.evaluate(() => localStorage.removeItem("ddn.channels.open"));
    await nav(p, "settings");
    await p.reload();
    await p.waitForSelector("body[data-ready='1']");
    await p.waitForSelector("[data-ddn=channels-toggle]");
    // Folded by default when there are channels.
    ch.foldedByDefault = (await p.getAttribute("[data-ddn=channels-toggle]", "aria-expanded")) === "false" && (await p.isHidden("[data-ddn=channels-body]"));
    ch.summary = await p.textContent("[data-ddn=channels-summary]");
    await p.click("[data-ddn=channels-toggle]");
    await p.waitForSelector("[data-ddn=channels-body]:not([hidden])");
    await p.reload();
    await p.waitForSelector("body[data-ready='1']");
    await p.waitForSelector("[data-ddn=channels-toggle]");
    ch.foldKept = (await p.getAttribute("[data-ddn=channels-toggle]", "aria-expanded")) === "true";
    // A new channel with one file on it only (the step's own folder).
    await pasteInto(p, "[data-ddn=webhook-url]", extraHook);
    await p.click("[data-ddn=add-webhook]");
    const extraId = /webhooks\/(\d+)\//.exec(extraHook)![1]!;
    await p.waitForSelector(`[data-ddn=channel-row][data-id="${extraId}"]`, { timeout: 30_000 });
    // Retire every other own channel for a moment (metadata only), so the next upload lands on the new one only.
    const others = SERVER_SIDE ? [] : (await p.$$eval("[data-ddn=channel-row]", (e) => e.map((x) => x.getAttribute("data-id")!))).filter((x) => x !== extraId);
    const critOf = async (id: string) => (await p.locator(`[data-ddn=channel-row][data-id="${id}"] [data-ddn=channel-critical]`).count()) > 0;
    for (const id of others) if (!(await critOf(id))) await p.evaluate((x) => (window as unknown as { ddnCore: { retireWebhook(i: string, r: boolean): Promise<void> } }).ddnCore.retireWebhook(x, true), id);
    const chDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-ch-"));
    writeFileSync(join(chDir, "kanal.txt"), "only on the new channel\n".repeat(2000));
    const chFolder = await p.evaluate(async () => (window as unknown as { ddnCore: { mkdir(n: string): Promise<string> } }).ddnCore.mkdir("Kanaly"));
    await p.goto(`${base}/folder/${chFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    // metadata only: the pointer channel is critical and still takes pieces; e2ee/plain: own channel only.
    const nonCrit = SERVER_SIDE ? [] : (await Promise.all(others.map(async (id) => ((await p.evaluate((x) => (window as unknown as { ddnCore: { webhooks(s: boolean): Promise<{ webhooks: { id: string; critical: boolean }[] }> } }).ddnCore.webhooks(true).then((w) => w.webhooks.find((y) => y.id === x)?.critical), id)) ? null : id)))).filter(Boolean);
    void nonCrit;
    await p.setInputFiles("[data-ddn=file]", [join(chDir, "kanal.txt")]);
    await p.waitForFunction((done) => document.querySelector("[data-ddn-ui=queue-title]")?.textContent === done, L.uploaded, { timeout: 120_000 });
    await count(p, L.one);
    for (const id of others) await p.evaluate((x) => (window as unknown as { ddnCore: { retireWebhook(i: string, r: boolean): Promise<void> } }).ddnCore.retireWebhook(x, false).catch(() => {}), id);
    await nav(p, "settings");
    await p.waitForSelector(`[data-ddn=channel-row][data-id="${extraId}"]`);
    ch.stats = await p.textContent(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=channel-stats]`);
    // Storage totals.
    await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=st-all]")?.textContent ?? ""));
    ch.totals = { all: await p.textContent("[data-ddn=st-all]"), trash: await p.textContent("[data-ddn=st-trash]"), unavail: await p.textContent("[data-ddn=st-unavail]"), discord: await p.textContent("[data-ddn=st-discord]"), tookMs: Number(await p.getAttribute("[data-ddn=st-all]", "data-took-ms")) };
    // The remove dialog of the new channel: impact by name, retire is the default.
    await p.click(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=remove-webhook]`);
    await p.waitForSelector("[data-ddn=channel-dialog][open]");
    await p.waitForFunction(() => document.querySelector("[data-ddn=chd-impact]")?.getAttribute("data-files") !== null, null, { timeout: 30_000 });
    ch.impact = { text: await p.textContent("[data-ddn=chd-impact]"), files: await p.$$eval("[data-ddn=chd-file] .dname", (e) => e.map((x) => x.textContent)), retireDefault: await p.isChecked("[data-ddn=chd-opt-retire]") };
    await shot(p, "23-channel-remove-dialog");
    await p.click("[data-ddn=chd-go]");
    await p.waitForSelector(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=channel-retired]`, { timeout: 30_000 });
    ch.retired = true;
    await p.click(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=channel-unretire]`);
    await p.waitForSelector(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=channel-retired]`, { state: "detached", timeout: 30_000 });
    ch.unretired = true;
    // A critical channel offers only "move".
    const crit = await p.locator("[data-ddn=channel-row]:has([data-ddn=channel-critical])").first();
    if ((await crit.count()) > 0) {
      await crit.locator("[data-ddn=remove-webhook]").click();
      await p.waitForSelector("[data-ddn=channel-dialog][open]");
      await p.waitForFunction(() => !document.querySelector<HTMLElement>("[data-ddn=chd-critical]")!.hidden, null, { timeout: 30_000 });
      ch.critical = { retire: await p.isDisabled("[data-ddn=chd-opt-retire]"), remove: await p.isDisabled("[data-ddn=chd-opt-remove]"), move: await p.isEnabled("[data-ddn=chd-opt-move]"), note: await p.textContent("[data-ddn=chd-critical]") };
      await shot(p, "24-channel-critical");
      await p.click("[data-ddn-ui=chd-cancel]");
    } else ch.critical = SERVER_SIDE ? "none-own" : "missing";
    // Remove anyway: needs the acknowledgement; the file becomes unavailable (hidden by default).
    await p.click(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=remove-webhook]`);
    await p.waitForSelector("[data-ddn=channel-dialog][open]");
    await p.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-ddn=chd-opt-remove]")!.disabled, null, { timeout: 30_000 });
    await p.check("[data-ddn=chd-opt-remove]");
    ch.ackNeeded = await p.isDisabled("[data-ddn=chd-go]");
    // Owner (#31): "Remove anyway" lists the files that become unavailable, and the full list downloads.
    await p.waitForSelector("[data-ddn=chd-remove-files]:not([hidden])");
    const [rl] = await Promise.all([p.waitForEvent("download", { timeout: 30_000 }), p.click("[data-ddn=chd-remove-export]")]);
    const rlText = readFileSync((await rl.path())!, "utf8");
    ch.removeList = { shown: await p.$$eval("[data-ddn=chd-remove-file] .dname", (e) => e.map((x) => x.textContent)), file: /Kanaly\/kanal\.txt/.test(rlText) };
    await shot(p, "23b-channel-remove-anyway-list");
    await p.check("[data-ddn=chd-ack]");
    await p.click("[data-ddn=chd-go]");
    await p.waitForSelector("[data-ddn=removed-row]", { timeout: 30_000 });
    ch.removedRow = await p.textContent("[data-ddn=removed-row]");
    await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=st-unavail]")?.textContent ?? "") , null, { timeout: 30_000 });
    ch.unavailTotal = await p.textContent("[data-ddn=st-unavail]");
    await p.goto(`${base}/folder/${chFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    await p.waitForSelector("[data-ddn-ui=empty]:not([hidden])", { timeout: 30_000 });
    ch.hiddenByDefault = (await p.locator("[data-ddn=row]").count()) === 0;
    ch.folderCountHidden = await p.textContent("[data-ddn-ui=folder-meta]");
    // The switch shows them, marked, with the reason.
    await nav(p, "settings");
    await p.check("[data-ddn=show-unavailable]");
    await p.goto(`${base}/folder/${chFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    await p.waitForSelector("[data-ddn=row][data-unavailable]", { timeout: 30_000 });
    ch.shown = { chip: await p.textContent("[data-ddn=unavailable-chip]"), why: await p.textContent("[data-ddn=unavailable-why]"), whyVisible: await p.isVisible("[data-ddn=unavailable-why]"), noDownload: (await p.locator("[data-ddn=row][data-unavailable] [data-ddn=share]").count()) === 0 && !(await p.isVisible("[data-ddn=row][data-unavailable] [data-ddn=download]")), deleteBtn: await p.isVisible("[data-ddn=row][data-unavailable] [data-ddn=unavailable-delete]") };
    await shot(p, "25-unavailable-shown");
    // Paste the same webhook again: available at once.
    await nav(p, "settings");
    await openChannels(p);
    await pasteInto(p, "[data-ddn=webhook-url]", extraHook);
    await p.click("[data-ddn=add-webhook]");
    await p.waitForSelector(`[data-ddn=channel-row][data-id="${extraId}"]`, { timeout: 30_000 });
    await p.waitForFunction(() => !/\d/.test(document.querySelector("[data-ddn=st-unavail]")?.textContent ?? "0"), null, { timeout: 30_000 }).catch(() => {});
    ch.unavailAfterPaste = await p.textContent("[data-ddn=st-unavail]");
    await p.uncheck("[data-ddn=show-unavailable]");
    await p.goto(`${base}/folder/${chFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    await count(p, L.one);
    ch.backAfterPaste = (await p.locator("[data-ddn=row][data-unavailable]").count()) === 0;
    // Move and remove the new channel: everything ends up on the others, the file still downloads.
    await nav(p, "settings");
    await openChannels(p);
    await p.click(`[data-ddn=channel-row][data-id="${extraId}"] [data-ddn=remove-webhook]`);
    await p.waitForSelector("[data-ddn=channel-dialog][open]");
    await p.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-ddn=chd-opt-move]")!.disabled, null, { timeout: 30_000 });
    await p.check("[data-ddn=chd-opt-move]");
    ch.moveText = await p.textContent("[data-ddn-ui=chd-opt-move-t]");
    await p.click("[data-ddn=chd-go]");
    await p.waitForSelector("[data-ddn=channel-move]:not([hidden])", { timeout: 30_000 });
    await p.waitForFunction(() => document.querySelector<HTMLElement>("[data-ddn=channel-move]")?.dataset.state === "done", null, { timeout: 180_000 });
    ch.moveDone = await p.textContent("[data-ddn=channel-move-text]");
    await shot(p, "26-channel-moved");
    await p.waitForFunction((id) => !document.querySelector(`[data-ddn=channel-row][data-id="${id}"]`), extraId, { timeout: 60_000 });
    ch.goneAfterMove = true;
    await p.goto(`${base}/folder/${chFolder}`);
    await p.waitForSelector("body[data-ready='1']");
    await count(p, L.one);
    const [cdl] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), p.locator("[data-ddn=row]", { hasText: "kanal.txt" }).locator("[data-ddn=download]").click()]);
    ch.downloadAfterMove = sha(readFileSync((await cdl.path())!)) === sha(readFileSync(join(chDir, "kanal.txt")));
    // Phone: the Settings section folds and has no horizontal scroll.
    await m.reload();
    await m.waitForSelector("body[data-ready='1']");
    await nav(m, "settings");
    await m.waitForSelector("[data-ddn=channels-toggle]");
    ch.phone = { folded: (await m.getAttribute("[data-ddn=channels-toggle]", "aria-expanded")) === "false", noHScroll: await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1) };
    await shot(m, "27-phone-settings-channels");
  } else ch.skipped = "no extra webhook";
  r.channels = ch;

  // 10d. a browser without Ed25519 in WebCrypto (Chromium before 137): every sign-up card says "too old"
  // with the versions instead of the raw "Algorithm: Unrecognized name", its buttons are off.
  step("old browser");
  {
    const oc = await browser.newContext({ colorScheme: SCHEME });
    await oc.addInitScript({
      content: `window.__name = (f) => f; try { localStorage.setItem("ddn.lang", ${JSON.stringify(LANG)}) } catch {}
        const g = crypto.subtle.generateKey.bind(crypto.subtle);
        crypto.subtle.generateKey = (alg, ...a) => (String(alg && alg.name || alg).toLowerCase() === "ed25519" ? Promise.reject(new TypeError("Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name")) : g(alg, ...a));`,
    });
    const op = await newPage(oc);
    await op.goto(base);
    await op.waitForSelector("body[data-ready='1']");
    await op.waitForSelector("[data-ddn=old-browser]");
    r.oldBrowser = await op.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-ddn=signed-out] .auth-card")];
      const notes = cards.filter((c) => c.querySelector("[data-ddn=old-browser]"));
      const btns = cards.flatMap((c) => [...c.querySelectorAll<HTMLButtonElement>(".auth-body button")]);
      return { cards: notes.length, buttonsDisabled: btns.length > 0 && btns.every((b) => b.disabled), text: notes[0]?.textContent ?? "", noRawError: !/Unrecognized name/.test(document.body.innerText) };
    });
    await shot(op, "33-old-browser");
    await oc.close();
    // A current browser shows no such note.
    (r.oldBrowser as Record<string, unknown>).modernNoNote = !(await p.$("[data-ddn=old-browser]"));
  }

  // 11. what the server stores: no names in clear
  if (srv) {
    const tables = ["devices", "log", "shares", "vault", "s_blobs", "s_uploads", "inst_hooks", "s_snapshots", "password_keys"].filter((t) => srv!.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const rows = tables.map((t) => srv!.db.prepare(`SELECT * FROM ${t}`).all());
    r.serverTables = tables;
    r.serverSeesNoNames = !/Telefon testowy|Laptop testowy|notatki|Wakacje|duzy\.bin|discord\.com\/api\/webhooks|check run passphrase/.test(JSON.stringify(rows));
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
    ...(!SERVER_SIDE && fake && hookUrls[1]
      ? { pasteManyWebhooks: /^5/.test(String((r.pasteManyWebhooks as { count?: string } | undefined)?.count)) && (r.pasteManyWebhooks as { fieldEmpty: boolean }).fieldEmpty === true }
      : {}),
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
    download: r.downloadSha256Ok === true && (remote ? true : r.downloadStreamed === true),
    liveSpeed: (() => {
      const u = r.uploadSpeed as { file: string | null; meta: string | null };
      const d = r.downloadPanel as { shown: boolean; name: string; state: string; speed: string; bar: string };
      return /MB\/s/.test(String(u.file)) && /MB\/s/.test(String(u.meta)) && d.shown && d.name === "duzy.bin" && d.state === "done" && /MB\/s/.test(String(d.speed)) && d.bar === "100%";
    })(),
    transferLog: (() => {
      const l = r.transferLog as Record<string, any>;
      return (
        r.diagOffByDefault === true && /\(\d+\)/.test(String(r.concAuto)) && (r.concSet as { download: number }).download === 6 && !!l && l.bad === 0 && l.noSecrets === true && l.upEnd && l.downEnd && l.ext === "bin" && l.fragsUp === 2 && l.reqsDown >= 2 &&
        (SERVER_SIDE ? l.serverLines > 0 && l.serverPosts >= 3 : l.serverLines === 0) && l.report.files.length >= 2 && /\.jsonl(\.gz)?$/.test(l.file)
      );
    })(),
    transferLogClear: (() => {
      const c = r.transferLogClear as { lines: number; emptyToast: boolean; toastSaysKept: boolean } | undefined;
      return !!c && c.lines === 0 && c.emptyToast && c.toastSaysKept;
    })(),
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
    storage: (() => {
      const o = (r.ops as { storage?: { before: { by: string; last: string; waiting: string }; after: { last: string; result: string; waiting: string } } } | undefined)?.storage;
      if (!o) return false;
      // Who cleans matches the mode; before the first run "not yet", after it a time; the purged
      // notatki.txt version waits for the retention (the purged folder had no upload).
      const by = SERVER_SIDE ? /server|serwer/ : /browser|przeglądarka/;
      // e2ee/plain: "last cleanup" is the instance's background pass (every 30 s on a live server), so it may be set already.
      return by.test(o.before.by) && (SERVER_SIDE || /not yet|jeszcze nie/.test(o.before.last)) && !/not yet|jeszcze nie/.test(o.after.last) && /\d/.test(o.after.result) && /^1 /.test(o.after.waiting);
    })(),
    passwordSignIn: (() => {
      const o = r.ops as Record<string, unknown> | undefined;
      return !!o && o.pwDefaultOff === true && /good|strong|dobre|mocne/.test(String(o.pwStrength)) && o.pwNeedsAck === true && /Wrong login or password|Zły login albo hasło/.test(String(o.pwWrong)) && o.pwSignedIn === true && o.pwOff === true;
    })(),
    // The note under the queue is true in this mode; plain says nothing about encryption.
    modeTexts:
      MODE === "plain"
        ? /through the server|przez serwer/.test(String(r.queueNote)) && !/ncrypt|szyfr/i.test(String(r.queueNote)) && !/ncrypt|szyfr|end-to-end/i.test(String(r.createSub))
        : MODE === "e2ee"
          ? /encrypted in this tab and go through the server|szyfrowane w tej karcie i trafiają przez serwer/.test(String(r.queueNote))
          : /^(Encryption and upload only run|Szyfrowanie i wysyłanie trwa)/.test(String(r.queueNote)),
    serverBlind: MODE === "plain" ? true : r.serverSeesNoNames !== false,
    channels: (() => {
      const c = r.channels as Record<string, unknown> | undefined;
      if (!c || c.skipped) return !!remote && !!c?.skipped;
      const crit = c.critical as { retire: boolean; remove: boolean; move: boolean } | string;
      const imp = c.impact as { text: string; files: string[]; retireDefault: boolean };
      const sh = c.shown as { chip: string; why: string; whyVisible: boolean; noDownload: boolean; deleteBtn: boolean };
      return (
        c.foldedByDefault === true && c.foldKept === true && /\d/.test(String(c.summary)) &&
        /1 (file|plik)/.test(String(c.stats)) && /\d/.test(String((c.totals as { all: string }).all)) &&
        JSON.stringify(imp.files) === JSON.stringify(["kanal.txt"]) && imp.retireDefault && c.retired === true && c.unretired === true &&
        (typeof crit === "string" ? (SERVER_SIDE && crit === "none-own") : crit.retire && crit.remove && crit.move) &&
        c.ackNeeded === true && JSON.stringify((c.removeList as { shown: string[] }).shown) === JSON.stringify(["kanal.txt"]) && (c.removeList as { file: boolean }).file && /1/.test(String(c.unavailTotal)) && c.hiddenByDefault === true && /Unavailable|Niedostępny/.test(sh.chip) && /\(#…\d{6}\)/.test(sh.why) && sh.whyVisible && sh.noDownload && sh.deleteBtn &&
        c.backAfterPaste === true && /moved|przeniesiony/i.test(String(c.moveDone)) && c.goneAfterMove === true && c.downloadAfterMove === true &&
        (c.phone as { folded: boolean; noHScroll: boolean }).folded && (c.phone as { noHScroll: boolean }).noHScroll
      );
    })(),
    preview: (() => {
      const o = r.preview as Record<string, any> | undefined;
      if (!o) return false;
      const md = o.md as Record<string, unknown>;
      return (
        o.text === true && o.prevDisabledAtFirst === true &&
        md.h1 === "Podgląd" && md.strong === "bold" && md.li === 2 && md.noScript === true && md.noImg === true && md.noHandlers === true && md.noJsHref === true && md.rawShownAsText === true && md.evilAsText === true && md.pwned === null &&
        JSON.stringify(md.ok) === JSON.stringify([["https://example.com/", "noopener noreferrer", "_blank"]]) &&
        o.json === true &&
        JSON.stringify(o.csv) === JSON.stringify([["city", "note"], ["Kraków", "comma, inside"], ["Gdańsk", 'line\nbreak and "quotes"']]) &&
        o.jpg.w === 64 && o.jpg.h === 48 && o.jpg.src === "blob:" && o.jpg.type === "image/jpeg" &&
        o.pdf.tag === "IFRAME" && o.pdf.src === "blob:" && o.pdf.type === "application/pdf" &&
        o.svg.tag === "IMG" && o.svg.w === 40 && o.svg.src === "blob:" && o.svg.type === "image/svg+xml" && o.svg.inline === false && o.svg.pwned === null &&
        o.nextDisabledAtLast === true && o.staysAtLast === true && o.arrowLeft === true && o.escapeCloses === true &&
        o.quickArrows.file === "e.jpg" && o.quickArrows.bodyKids === 1 && o.quickArrows.img === true &&
        o.blobsRevoked.shown >= 4 && o.blobsRevoked.open === 0 && o.pwned === null &&
        o.phone.noHScroll === true && o.phone.full === true && o.phone.arrows === true && o.phonePdf.message === true && o.phonePdf.noFrame === true && o.phonePdf.download === true
      );
    })(),
    contextMenu: (() => {
      const o = r.contextMenu as Record<string, any> | undefined;
      if (!o) return false;
      const area = o.areaItems as string[];
      const row = o.rowItems as string[];
      return (
        o.trashNextToDownload === true && o.trashNoConfirm === true && o.trashUndo === true && o.folderRowHasTrash === true &&
        ["menu-new-folder", "menu-upload", "menu-select-all", "menu-view-list", "menu-view-tiles", "menu-sort-name", "menu-sort-size", "menu-sort-date", "menu-sort-asc", "menu-sort-desc", "menu-refresh"].every((k) => area.includes(k)) &&
        o.newFolderFirst === true &&
        ["menu-preview", "menu-download", "menu-rename", "menu-move", "menu-trash"].every((k) => row.includes(k)) && o.rightClickNoPreview === true && o.renamedFromContext === true &&
        o.keyboard.first === "menu-preview" && o.keyboard.down === "menu-download" && o.keyboard.end === "menu-trash" && o.keyboard.back === true && o.keyboard.previewClosed === true &&
        o.sortSize === true && o.sortKept === true &&
        o.tiles.view === "tiles" && o.tiles.grid && o.tiles.cols >= 3 && o.tiles.pressed === "tiles" && o.tilesKept.view === "tiles" && o.tilesKept.grid && o.viewChecked === "true" && o.listAgain === true &&
        o.phone.view === "tiles" && o.phone.grid && o.phone.cols >= 2 && o.phone.noHScroll && o.phone.longPress && o.phone.noPreview && o.phone.trashShown &&
        JSON.stringify(o.trashItems) === JSON.stringify(["menu-restore", "menu-purge"]) && o.trashRestored === true && o.nativeInInputs === true
      );
    })(),
    queueCloses: (() => {
      const o = r.queueCloses as Record<string, any> | undefined;
      return (
        !!o && o.okClosedMs >= 4000 && o.okClosedMs < 9000 && o.hoverKeeps === true && o.closedAfterLeave === true &&
        o.errStillShownAt7s === true && o.failedBar.shown === true && /^1 /.test(String(o.failedBar.count)) && o.errClosedMs >= 10_000 && o.errClosedMs < 17_000 &&
        o.failedBarAfter === true && /^bad/.test(String(o.failedItem)) && o.retried === true && o.xCloses === true && o.dismissed === true
      );
    })(),
    network: (() => {
      const o = r.network as Record<string, any> | undefined;
      if (!o) return false;
      // 4 fragments + manifest; the reload stopped it after >= 2 posts: the resumed run sends only the rest.
      // resumed = pieces taken over (from the queue item's tooltip); a snapshot post may add 1–2 to the count.
      const resumed = Number(/\d+/.exec(String(o.title))?.[0] ?? 0);
      const resumeOk = remote ? true : o.unfinishedShown === true && /wznow\.bin/.test(String(o.unfinishedText)) && o.sentBefore >= 2 && resumed >= 1 && resumed <= o.sentBefore && o.sentAfter <= 5 - resumed + 2 && o.unfinishedGone === true && o.resumeSha === true;
      return (
        o.lanes === 2 && o.laneSha === true && (o.laneOrigins === null || (o.laneOrigins as string[]).includes("null")) &&
        /network|sieć|sieci/i.test(String(o.offlineText)) && o.noErrorWhileOffline === true && o.resumedShown === true && o.offlineSha === true &&
        o.guardDefault === true && o.saveData.on === true && o.saveData.upMax <= 2 && o.saveData.downMax <= 2 && o.saveData.guard === false && o.guardDisabledBySaveData === true && o.kept === true && o.back === true && /\d/.test(String(o.info)) &&
        // save data is said in the panel (2 at once + the reason + a link to the setting), and in the section chip
        o.leanPanel.shown === true && /2/.test(o.leanPanel.text) && o.leanPanel.why === "setting" && /settings|ustawieniach/i.test(o.leanPanel.text) && o.leanPanel.href === "/settings#network" && o.leanGone === true && !!o.chip &&
        resumeOk
      );
    })(),
    netSection: (() => {
      const n = r.netSection as Record<string, unknown> | undefined;
      return !!n && n.visible === true && n.save === true && n.guard === true && n.conc === true && n.notInDiag === true && /Network|Sieć/.test(String(n.title));
    })(),
    oldBrowser: (() => {
      const o = r.oldBrowser as Record<string, unknown> | undefined;
      return !!o && o.cards === 4 && o.buttonsDisabled === true && /137/.test(String(o.text)) && /129/.test(String(o.text)) && /17/.test(String(o.text)) && /Ed25519/.test(String(o.text)) && o.noRawError === true && o.modernNoNote === true;
    })(),
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
