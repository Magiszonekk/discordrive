// QA on Windows (workflow qa-windows.yml, started by hand): the INSTALLED app (the .exe installer of a CI run)
// goes through the smoke scenarios S1–S8 of the QA plan with a screenshot after every step. Nothing here
// fails the build: every step records ok / not ok and a reason; the screenshots and report.json are the
// result (artifact qa-windows-shots).
//   npx tsx apps/desktop/test/qa-windows.ts <installed discordrive.exe> <shots dir>
//   (a local try: QA_APP_DIR=apps/desktop with the electron binary as the first argument)
// Discord is a local fake (no real channels); the account lives on the app's built-in instance.
// The installed app is driven through Chromium's remote debugging port (chromium.connectOverCDP): the release
// build's fuses turn off Node's --inspect, which Playwright's _electron needs; the window itself is the same.
// The main process is not reachable then, so the clipboard is read in the page (navigator.clipboard).
// QA_APP_DIR (a local try with a plain electron binary): _electron as before.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from "playwright";
import { FakeDiscord } from "@ddv4/metadata-client/node";

const [exe, shots] = process.argv.slice(2);
if (!exe || !shots) throw new Error("usage: qa-windows.ts <discordrive.exe> <shots dir>");
mkdirSync(shots, { recursive: true });
const work = join(process.env.RUNNER_TEMP ?? tmpdir(), "ddn-qa");
const data = join(work, "data");
const downloads = join(work, "downloads");
mkdirSync(downloads, { recursive: true });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// The fake Discord over TLS (the app talks HTTPS to Discord; the test CA is given to the agent).
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "k"), "-out", join(work, "c"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const fake = new FakeDiscord();
const origin = await fake.listen({ tls: { key: readFileSync(join(work, "k")), cert: readFileSync(join(work, "c"), "utf8") } });

type Step = { id: string; what: string; ok: boolean; note: string; shot: string };
const steps: Step[] = [];
let n = 0;
const consoleErrs: string[] = [];
/** Settings → a tab, by clicking (as a user). */
async function settingsTab(p: Page, tab: string) {
  if (!(await p.isVisible("[data-page=settings]:not([hidden])"))) {
    await p.click("a[data-nav=settings]");
    await p.waitForSelector("[data-page=settings]:not([hidden])", { timeout: 30_000 });
  }
  // A DOM click (the router's link handler): pointer coordinates through remote debugging with the page's
  // metrics overridden do not always land on the link.
  await p.locator(`a[data-ddn=settings-tab][data-tab=${tab}]`).evaluate((el) => (el as HTMLElement).click());
  const ok = await p.waitForSelector(`[data-ddn=settings-tab][data-tab=${tab}][aria-current=page]`, { timeout: 10_000, state: "attached" }).then(() => true).catch(() => false);
  if (!ok) {
    const why = await p.evaluate(() => ({ path: location.pathname, current: [...document.querySelectorAll("[data-ddn=settings-tab][aria-current]")].map((e) => (e as HTMLElement).dataset.tab), pages: [...document.querySelectorAll("[data-page]")].filter((e) => !(e as HTMLElement).hidden).map((e) => (e as HTMLElement).dataset.page), dialogs: [...document.querySelectorAll("dialog[open]")].map((e) => e.getAttribute("data-ddn")) }));
    const calls = await p.evaluate(async () => {
      const c = (window as unknown as { ddnCore: Record<string, () => Promise<unknown>> }).ddnCore;
      const out: Record<string, string> = {};
      for (const k of ["status", "recoveredCount", "accountInfo", "webhooks", "netStatus"]) {
        const t0 = performance.now();
        out[k] = await Promise.race([c[k]!().then(() => `${Math.round(performance.now() - t0)} ms`, (e) => `err ${String(e).slice(0, 80)}`), new Promise<string>((r) => setTimeout(() => r("hangs"), 4000))]);
      }
      return out;
    });
    const later = await p.waitForSelector(`[data-ddn=settings-tab][data-tab=${tab}][aria-current=page]`, { timeout: 60_000, state: "attached" }).then(() => "opened within 70 s").catch(() => "not in 70 s");
    Object.assign(why, { calls, later, title: await p.title(), visible: await p.evaluate(() => document.visibilityState) });
    throw new Error(`tab ${tab} not opened: ${JSON.stringify(why)}; console: ${consoleErrs.slice(-3).join(" | ")}`);
  }
}
async function shot(p: Page, id: string): Promise<string> {
  const f = `${String(++n).padStart(2, "0")}-${id}.png`;
  await p.screenshot({ path: join(shots, f) }).catch(() => {});
  return f;
}
async function step(p: Page, id: string, what: string, run: () => Promise<{ ok: boolean; note?: string }>) {
  // QA_SKIP=S3,S4: leave steps out (a quick local try).
  if ((process.env.QA_SKIP ?? "").split(",").includes(id.split("-")[0]!)) return;
  let ok = false;
  let note = "";
  try {
    const r = await run();
    ok = r.ok;
    note = r.note ?? "";
  } catch (e) {
    note = String((e as Error)?.message ?? e).slice(0, 400);
  }
  steps.push({ id, what, ok, note, shot: await shot(p, id) });
  console.error(`[qa] ${id} ${ok ? "ok" : "NOT OK"} ${note}`);
}

/** The whole screen (Windows: PowerShell + System.Drawing), also when the window cannot be reached. */
function desktopShot(name: string) {
  if (process.platform !== "win32") return;
  const f = join(shots, `${String(++n).padStart(2, "0")}-${name}.png`);
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size); $i.Save('${f.replace(/'/g, "''")}'); $g.Dispose(); $i.Dispose()`], { stdio: "ignore", timeout: 30_000 });
  } catch {
    /* no desktop session */
  }
}

let app: ElectronApplication | null = null;
let cdp: Browser | null = null;
let child: ChildProcess | null = null;
const env = { ...process.env, DDN_DESKTOP_DATA: data, DDN_DESKTOP_DOWNLOADS: downloads, DDN_DESKTOP_TEST_DISCORD: origin, DDN_DESKTOP_TEST_CA: join(work, "c") } as Record<string, string>;
try {
  desktopShot("desktop-before");
  let p: Page;
  if (process.env.QA_APP_DIR) {
    app = await electron.launch({ executablePath: exe, args: [process.env.QA_APP_DIR, ...(process.platform === "linux" ? ["--no-sandbox"] : [])], env, timeout: 90_000 });
    p = await app.firstWindow();
  } else {
    const port = 9333;
    child = spawn(exe, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", ...(process.platform === "linux" ? ["--no-sandbox"] : [])], { env, stdio: "ignore" });
    let last: unknown = null;
    for (let i = 0; i < 90 && !cdp; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch((e) => ((last = e), null));
    }
    desktopShot("desktop-started");
    if (!cdp) throw new Error(`no remote debugging port on the installed app after 90 s: ${String(last)}`);
    let page: Page | undefined;
    for (let i = 0; i < 60 && !page; i++) {
      page = cdp.contexts().flatMap((c) => c.pages()).find((x) => /^app:/.test(x.url()));
      if (!page) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!page) throw new Error(`no app window among ${cdp.contexts().flatMap((c) => c.pages()).map((x) => x.url()).join(", ")}`);
    p = page;
  }
  p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && consoleErrs.push(m.text().slice(0, 300)));
  p.on("pageerror", (e) => consoleErrs.push(`pageerror: ${String(e).slice(0, 300)}`));
  // tsx names the functions it passes to the page (__name): the page needs the helper.
  await p.addInitScript({ content: "window.__name = (f) => f" });
  await p.evaluate("window.__name = (f) => f").catch(() => {});
  // The window's size: Playwright's viewport with _electron; through remote debugging the window itself.
  // (Electron has no Browser.setWindowBounds: the page's metrics are set instead, which is what the layout sees.)
  const cdpS = app ? null : await p.context().newCDPSession(p);
  const resize = async (width: number, height: number) => {
    if (app) return p.setViewportSize({ width, height });
    await cdpS!.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await p.waitForTimeout(400);
  };
  await resize(1280, 860).catch(() => {});
  const core = <T>(m: string, ...a: unknown[]) => p.evaluate(({ m, a }) => (window as unknown as { ddnCore: Record<string, (...x: unknown[]) => Promise<unknown>> }).ddnCore[m]!(...a), { m, a }) as Promise<T>;

  await step(p, "S1-start", "Start: the start page, no errors", async () => {
    await p.waitForSelector("[data-ddn=start-local]", { timeout: 60_000 });
    return { ok: true };
  });
  await step(p, "S2-account", "Account on 'This computer only', a channel, the rescue kit", async () => {
    await p.click("[data-ddn=start-local]");
    await p.click("[data-ddn=start-accept]");
    await p.waitForSelector("[data-ddn=create]", { timeout: 60_000 });
    await p.fill("[data-ddn=device-name]", "QA Windows");
    await p.click("[data-ddn=create]");
    await p.waitForSelector("[data-ddn-ui=onboarding]:not([hidden]) [data-ddn=webhook-url]", { timeout: 60_000 });
    await p.fill("[data-ddn=webhook-url]", fake.addWebhook("1550000000000000901").url);
    await p.keyboard.press("Enter");
    await p.waitForSelector("[data-ddn=kit-dialog][open]", { timeout: 60_000 });
    return { ok: true };
  });
  await step(p, "S6-copy-kit", "Copy the rescue kit: the system clipboard has it", async () => {
    // Through remote debugging the main process is not reachable and the page's own clipboard read waits for a
    // permission (and holds up the window): the system's clipboard tool reads it instead.
    const osClip = () => {
      try {
        if (process.platform === "win32") return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", timeout: 20_000 }).trim();
        if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8", timeout: 10_000 });
        return execFileSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8", timeout: 10_000 });
      } catch {
        return "";
      }
    };
    if (app) await app.evaluate(({ clipboard }) => clipboard.writeText("qa-before"));
    await p.click("[data-ddn=kit-copy]");
    await p.waitForTimeout(600);
    const clip = app ? await app.evaluate(({ clipboard }) => clipboard.readText()) : osClip();
    await p.check("[data-ddn=kit-ack]");
    await p.click("[data-ddn=kit-done]");
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 30_000 });
    return { ok: clip.startsWith("ddn-kit"), note: clip.slice(0, 9) };
  });
  const v = await p.evaluate(() => document.querySelector("[data-ddn=diag-version]")?.textContent ?? "");
  void v;
  const MB = 200;
  const src = join(work, `qa-${MB}mb.bin`);
  const big = randomBytes(MB * 1024 * 1024);
  writeFileSync(src, big);
  const signedIn = await p.evaluate(() => !!(window as unknown as { ddnCore?: unknown }).ddnCore).catch(() => false);
  if (!signedIn) throw new Error("the app did not reach its signed-in window (see the screenshots above)");
  await step(p, "S3-upload", "Upload 200 MB from disk (dropped on the window; through remote debugging by its path, as a drop does): the queue shows progress, the file is listed", async () => {
    // Dropped on the window, as a user does (the File objects of a real file chooser carry their paths).
    fake.postDelayMs = 300;
    await p.evaluate("window.__name = (f) => f");
    // Remote debugging cannot hand a file of this size to the page: the same call a drop ends in (the paths).
    if (!app) void core("uploadPaths", [src]).catch(() => null);
    else await p.evaluate(() => {
      const i = document.createElement("input");
      i.type = "file";
      i.id = "qa-drop-src";
      i.hidden = true;
      document.body.append(i);
    });
    if (app) await p.setInputFiles("#qa-drop-src", [src]);
    if (app) await p.evaluate(() => {
      const i = document.getElementById("qa-drop-src") as HTMLInputElement;
      const dt = new DataTransfer();
      for (const f of i.files!) dt.items.add(f);
      document.querySelector("[data-page=files]")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      i.remove();
    });
    const mid = await p
      .waitForFunction(() => {
        const st = document.querySelector("[data-ddn=queue-item] .qstate")?.textContent ?? "";
        const pct = Number(/^(\d+)%$/.exec(st)?.[1] ?? "-1");
        return pct > 0 && pct < 100 ? st : null;
      }, null, { timeout: 60_000, polling: 100 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    await shot(p, "S3-upload-running");
    if (app) await p.waitForFunction(() => document.querySelector("[data-ddn=queue-item] .qstate")?.classList.contains("done"), null, { timeout: 300_000 });
    else
      for (let i = 0; i < 300; i++) {
        if ((await core<{ rows: { name: string }[] }>("list")).rows.some((x) => x.name === `qa-${MB}mb.bin`)) break;
        await p.waitForTimeout(1000);
      }
    fake.postDelayMs = 0;
    const rows = (await core<{ rows: { name: string }[] }>("list")).rows;
    // Through remote debugging the upload starts in the agent (no row in the window's queue): the file counts.
    return { ok: (!!mid || !app) && rows.some((x) => x.name === `qa-${MB}mb.bin`), note: `in progress: ${mid ?? (app ? "not seen" : "started by path, no queue row")}` };
  });
  await step(p, "S4-download", "Download it: the downloads panel, the file in the folder, Show in folder", async () => {
    await p.reload();
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 });
    await p.locator("[data-ddn=row]", { hasText: `qa-${MB}mb.bin` }).locator("[data-ddn=download]").click();
    const btn = await p.waitForSelector("[data-ddn=dl-show-btn], [data-ddn=dl-show]", { timeout: 180_000 }).then(() => true).catch(() => false);
    const f = readdirSync(downloads).find((x) => x.startsWith(`qa-${MB}mb`));
    const same = !!f && sha(readFileSync(join(downloads, f))) === sha(big);
    return { ok: btn && same, note: `file: ${f ?? "none"}, sha ${same ? "ok" : "differs"}` };
  });
  await step(p, "S5-video", "Play an MP4 with moov at the end, seek to the middle", async () => {
    let mp4 = "";
    try {
      mp4 = join(work, "phone.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
    } catch {
      return { ok: false, note: "no ffmpeg on the runner" };
    }
    await core("uploadPaths", [mp4]);
    await p.reload();
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 });
    await p.locator("[data-ddn=row]", { hasText: "phone.mp4" }).locator("[data-ddn=play]").click();
    const r = await p.evaluate(
      () =>
        new Promise<{ t: number; err: number | null }>((res) => {
          const el = document.querySelector<HTMLVideoElement>("[data-ddn=player]")!;
          el.muted = true;
          const done = () => res({ t: el.currentTime, err: el.error?.code ?? null });
          el.addEventListener("error", done, { once: true });
          el.addEventListener("seeked", () => setTimeout(done, 500), { once: true });
          const tu = () => {
            if (el.currentTime > 0.3) {
              el.removeEventListener("timeupdate", tu);
              el.currentTime = 10;
            }
          };
          el.addEventListener("timeupdate", tu);
          void el.play().catch(() => {});
          setTimeout(done, 60_000);
        }),
    );
    return { ok: r.err === null && r.t >= 9.5, note: JSON.stringify(r) };
  });
  await p.evaluate(() => document.querySelector<HTMLDialogElement>('[data-ddn-ui="player-dialog"]')?.close());
  await step(p, "S7-tabs", "Settings tabs at 1024, 1100, 1280, 1920: the bar and the content stay put", async () => {
    const moved: string[] = [];
    for (const w of [1024, 1100, 1280, 1920]) {
      await resize(w, 900);
      const boxes: string[] = [];
      for (const tab of ["channels", "account", "storage", "network", "appearance", "app"]) {
        await settingsTab(p, tab);
        await p.waitForTimeout(150);
        boxes.push(
          await p.evaluate(() => {
            window.scrollTo(0, 0);
            const t = document.querySelector("[data-ddn=settings-tabs]")!.getBoundingClientRect();
            const s = [...document.querySelectorAll("[data-page=settings] .sections > section")].find((x) => (x as HTMLElement).offsetParent !== null)!.getBoundingClientRect();
            return [t.left, t.top, t.width, s.left, s.top].map(Math.round).join(",");
          }),
        );
      }
      if (new Set(boxes).size !== 1) moved.push(String(w));
      await shot(p, `S7-tabs-${w}`);
    }
    await resize(1280, 860).catch(() => {});
    return { ok: moved.length === 0, note: moved.length ? `moved at ${moved.join(", ")}` : "" };
  });
  await step(p, "S8-channels", "The channel list only in Channels & webhooks, not in Storage, not foldable", async () => {
    await settingsTab(p, "storage");
    const inStorage = await p.locator("#storage [data-ddn=channel-row], [data-ddn=st-channels]").count();
    await settingsTab(p, "channels");
    await p.waitForSelector("[data-ddn=channel-row]", { timeout: 10_000 });
    const toggle = await p.locator("[data-ddn=channels-toggle]").count();
    return { ok: inStorage === 0 && toggle === 0, note: `in Storage: ${inStorage}, fold button: ${toggle}` };
  });
  await step(p, "S1-version", "Settings → App: the version is the tested build", async () => {
    await settingsTab(p, "app");
    const ver = await p.waitForFunction(() => document.querySelector("[data-ddn=app-version]")?.textContent || "", null, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<string>).catch(() => "");
    const want = process.env.QA_BUILD ?? "";
    return { ok: !!ver && !/dev/.test(ver) && (!want || ver.includes(want)), note: `${ver}${want ? ` (expected ${want})` : ""}` };
  });
} catch (e) {
  steps.push({ id: "crash", what: "the run itself", ok: false, note: String((e as Error)?.stack ?? e).slice(0, 800), shot: "" });
} finally {
  desktopShot("desktop-end");
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  await cdp?.close().catch(() => {});
  child?.kill();
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/IM", "discordrive.exe", "/F", "/T"], { stdio: "ignore" });
    } catch {}
  }
  await fake.close();
}
const report = { at: new Date().toISOString(), exe, build: process.env.QA_BUILD ?? null, ok: steps.length > 0 && steps.every((s) => s.ok), steps };
writeFileSync(join(shots, "report.json"), JSON.stringify(report, null, 1));
writeFileSync(join(shots, "report.md"), [`# QA Windows ${report.at}`, "", `build: ${report.build ?? "?"}`, "", "| step | ok | note | screenshot |", "|---|---|---|---|", ...steps.map((s) => `| ${s.id} — ${s.what} | ${s.ok ? "ok" : "**not ok**"} | ${s.note.replace(/\|/g, "/")} | ${s.shot} |`)].join("\n") + "\n");
console.log(JSON.stringify(report, null, 1));
void existsSync;
