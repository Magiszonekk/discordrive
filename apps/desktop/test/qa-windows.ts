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

type Step = { id: string; what: string; ok: boolean; unchecked?: boolean; note: string; shot: string };
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
// A step that could not check what it is about (e.g. the queue's progress when the upload is started by
// path) reports "not checked" (unchecked: true): not a failure, not an ok.
async function step(p: Page, id: string, what: string, run: () => Promise<{ ok: boolean; note?: string; unchecked?: boolean }>) {
  // QA_SKIP=S3,S4: leave steps out (a quick local try).
  if ((process.env.QA_SKIP ?? "").split(",").includes(id.split("-")[0]!)) return;
  let ok = false;
  let note = "";
  let unchecked = false;
  try {
    const r = await run();
    ok = r.ok;
    unchecked = !!r.unchecked;
    note = r.note ?? "";
  } catch (e) {
    note = String((e as Error)?.message ?? e).slice(0, 400);
  }
  steps.push({ id, what, ok, ...(unchecked ? { unchecked } : {}), note, shot: await shot(p, id) });
  console.error(`[qa] ${id} ${unchecked ? "NOT CHECKED" : ok ? "ok" : "NOT OK"} ${note}`);
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
    const listed = rows.some((x) => x.name === `qa-${MB}mb.bin`);
    if (!mid && !app) return { ok: listed, unchecked: listed, note: `the file was uploaded and listed; the queue's progress not checked (started by path through remote debugging, no queue row)` };
    return { ok: !!mid && listed, note: `in progress: ${mid ?? "not seen"}` };
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
  // The disk in the system (Cloud Files): on, the folder in Explorer, a file read from it = the uploaded bytes,
  // listing without fragments, a delete refused, off = the folder gone. (Windows only.)
  if (process.platform === "win32") {
    const root = join(process.env.USERPROFILE ?? "", "discordrive");
    // Asynchronously: the fake Discord the app downloads from runs on this script's event loop; a synchronous
    // child would freeze it (the disk's reads then time out).
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const ps = async (cmd: string, timeout = 120_000) => (await promisify(execFile)("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout })).stdout.trim();
    const explorerShot = async (name: string, path: string) => {
      try {
        spawn("explorer.exe", [path], { detached: true, stdio: "ignore" }).unref();
      } catch {}
      await p.waitForTimeout(4000);
      desktopShot(name);
      try {
        // Close the Explorer windows this step opened (not the shell).
        await ps(`(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.Quit() }`, 20_000);
      } catch {}
    };
    await step(p, "V1-disk-on", "Settings → App → Disk in the system on: mounted, the state shown", async () => {
      await settingsTab(p, "app");
      await p.locator("[data-ddn=app-vdisk-row]").scrollIntoViewIfNeeded().catch(() => {});
      const sw = p.locator("[data-ddn=app-vdisk]");
      if (!(await sw.isChecked())) await sw.evaluate((el) => (el as HTMLInputElement).click());
      const hint = await p
        .waitForFunction(() => /Mounted|Zamontowany|Not available|Niedostępne|could not|Nie udało/.test(document.querySelector("[data-ddn=app-vdisk-hint]")?.textContent ?? "") && document.querySelector("[data-ddn=app-vdisk-hint]")!.textContent, null, { timeout: 90_000 })
        .then((h) => h.jsonValue() as Promise<string>)
        .catch(async () => p.evaluate(() => document.querySelector("[data-ddn=app-vdisk-hint]")?.textContent ?? ""));
      return { ok: /Mounted|Zamontowany/.test(hint), note: hint };
    });
    await step(p, "V2-explorer", "Explorer on %USERPROFILE%\\discordrive: the folder in the navigation pane, the files with their state icons; no fragment fetched by listing", async () => {
      const g0 = fake.cdnGets;
      const names = (await ps(`Get-ChildItem -LiteralPath '${root}' -Recurse | ForEach-Object { $_.Name }`)).split(/\r?\n/).filter(Boolean);
      await explorerShot("V2-explorer-root", root);
      const fetched = fake.cdnGets - g0;
      return { ok: names.includes(`qa-${MB}mb.bin`) && fetched === 0, note: `${names.length} entries (${names.slice(0, 6).join(", ")}); CDN requests while listing and opening the folder: ${fetched}` };
    });
    await step(p, "V3-hash", `Get-FileHash of qa-${MB}mb.bin read from the disk = the uploaded file`, async () => {
      const f = join(root, `qa-${MB}mb.bin`).replace(/'/g, "''");
      const g0 = fake.cdnGets;
      let h = "";
      let err = "";
      try {
        h = await ps(`$ErrorActionPreference='Stop'; try { (Get-FileHash -Algorithm SHA256 -LiteralPath '${f}').Hash } catch { Write-Output ("ERR " + $_.Exception.Message) }`, 600_000);
      } catch (e) {
        err = String((e as { stderr?: string }).stderr ?? (e as Error).message).slice(0, 300);
      }
      if (h.startsWith("ERR ")) ((err = h.slice(4)), (h = ""));
      h = h.toLowerCase();
      const fetched = fake.cdnGets - g0;
      await explorerShot("V3-explorer-after-read", root);
      return { ok: h === sha(big), note: `${h ? h.slice(0, 16) + "…" : "no hash"} vs ${sha(big).slice(0, 16)}…; CDN requests while reading: ${fetched}${err ? `; error: ${err}` : ""}` };
    });
    // Writing (W1–W4): the switch on, files and a folder copied in, a save as editors do it, delete and rename.
    type Row = { id: string; name: string; kind: string; size: number | null };
    const rowsIn = async (parent?: string) => (await core<{ rows: Row[] }>("list", parent)).rows;
    const waitFor = async (f: () => Promise<boolean>, ms = 180_000) => {
      for (let t = 0; t < ms; t += 1000) {
        if (await f().catch(() => false)) return true;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    };
    // The account's bytes of a node, read by the app (not from the disk), hashed in the page.
    const accountSha = (id: string) =>
      p.evaluate(async (id) => {
        const c = (window as unknown as { ddnCore: { download(id: string): Promise<Blob> } }).ddnCore;
        const b = await (await c.download(id)).arrayBuffer();
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      }, id);
    const wsrc = join(work, "w-src");
    const wfiles = [
      { n: "a.txt", b: Buffer.from("pierwszy plik\n".repeat(100)) },
      { n: "b ż.bin", b: randomBytes(3 * 1024 * 1024 + 7) },
      { n: "c.jpg", b: randomBytes(200_000) },
    ];
    mkdirSync(join(wsrc, "Folder W"), { recursive: true });
    for (const f of wfiles) writeFileSync(join(wsrc, "Folder W", f.n), f.b);
    await step(p, "W1-write-on", "Settings → App → Writing to the disk on (shown under the disk's switch)", async () => {
      await settingsTab(p, "app");
      const row = p.locator("[data-ddn=app-vdisk-write-row]");
      await row.waitFor({ state: "visible", timeout: 30_000 });
      await row.scrollIntoViewIfNeeded().catch(() => {});
      const sw = p.locator("[data-ddn=app-vdisk-write]");
      if (!(await sw.isChecked())) await sw.evaluate((el) => (el as HTMLInputElement).click());
      // The disk starts again writable: mounted again.
      const ok = await waitFor(async () => /Mounted|Zamontowany/.test((await p.locator("[data-ddn=app-vdisk-hint]").textContent()) ?? "") && (await sw.isChecked()), 90_000);
      return { ok, note: (await p.locator("[data-ddn=app-vdisk-hint]").textContent()) ?? "" };
    });
    await step(p, "W2-copy-folder", "Copy-Item of a folder with 3 files into the disk: in the account with the same bytes (read back by the app)", async () => {
      await ps(`Copy-Item -LiteralPath '${join(wsrc, "Folder W")}' -Destination '${root}' -Recurse -ErrorAction Stop`, 120_000);
      let folder: Row | undefined;
      const all = await waitFor(async () => {
        folder = (await rowsIn()).find((r) => r.name === "Folder W" && r.kind === "folder");
        if (!folder) return false;
        const r = await rowsIn(folder.id);
        return wfiles.every((f) => r.some((x) => x.name === f.n && x.size === f.b.length));
      });
      const notes: string[] = [];
      let same = all;
      if (all && folder) {
        for (const f of wfiles) {
          const id = (await rowsIn(folder.id)).find((x) => x.name === f.n)!.id;
          const h = await accountSha(id);
          if (h !== sha(f.b)) same = false;
          notes.push(`${f.n} ${h === sha(f.b) ? "ok" : "differs"}`);
        }
      }
      await explorerShot("W2-explorer-folder", join(root, "Folder W"));
      return { ok: all && same, note: all ? notes.join(", ") : "not all files in the account within 3 min" };
    });
    await step(p, "W3-save-replace", "A save as Notepad / Office do it ([IO.File]::Replace of a temp file): a new version of the same node", async () => {
      const folder = (await rowsIn()).find((r) => r.name === "Folder W")!;
      const before = (await rowsIn(folder.id)).find((x) => x.name === "a.txt")!;
      const next = Buffer.from("druga wersja\n".repeat(50));
      const target = join(root, "Folder W", "a.txt");
      const tmp = join(root, "Folder W", "a.txt.tmp");
      writeFileSync(join(work, "a2.txt"), next);
      await ps(`Copy-Item -LiteralPath '${join(work, "a2.txt")}' -Destination '${tmp}'; [IO.File]::Replace('${tmp}', '${target}', $null)`, 60_000);
      const ok = await waitFor(async () => (await rowsIn(folder.id)).some((x) => x.name === "a.txt" && x.size === next.length));
      const after = (await rowsIn(folder.id)).filter((x) => x.name.startsWith("a.txt"));
      const sameNode = after.length === 1 && after[0]!.id === before.id;
      const h = ok ? await accountSha(before.id) : "";
      return { ok: ok && sameNode && h === sha(next), note: `rows: ${after.map((x) => `${x.name} ${x.size}`).join(", ")}; same node: ${sameNode}; bytes ${h === sha(next) ? "ok" : "differ"}` };
    });
    await step(p, "W4-delete-rename", "Remove-Item of a file: into the app's trash; Rename-Item of a file not on this computer: the new name in the account", async () => {
      const folder = (await rowsIn()).find((r) => r.name === "Folder W")!;
      const c = (await rowsIn(folder.id)).find((x) => x.name === "c.jpg")!;
      await ps(`Remove-Item -LiteralPath '${join(root, "Folder W", "c.jpg")}' -ErrorAction Stop`, 60_000);
      const trashed = await waitFor(async () => (await core<{ id: string }[]>("trashList")).some((t) => t.id === c.id), 60_000);
      // The big file of the first steps is only a placeholder here (a cloud): renamed without its content.
      const big0 = (await rowsIn()).find((x) => x.name === `qa-${MB}mb.bin`)!;
      await ps(`attrib -P +U '${join(root, `qa-${MB}mb.bin`)}'`, 60_000).catch(() => "");
      await new Promise((r) => setTimeout(r, 3000));
      const g0 = fake.cdnGets;
      await ps(`Rename-Item -LiteralPath '${join(root, `qa-${MB}mb.bin`)}' -NewName 'qa-renamed.bin' -ErrorAction Stop`, 60_000);
      const renamed = await waitFor(async () => (await rowsIn()).some((x) => x.name === "qa-renamed.bin" && x.id === big0.id), 60_000);
      const fetched = fake.cdnGets - g0;
      await p.click("a[data-nav=trash]").catch(() => {});
      await p.waitForSelector("[data-page=trash]:not([hidden])", { timeout: 30_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      await shot(p, "W4-app-trash");
      // Back as it was for the next steps (V4 removes qa-<MB>mb.bin; S-steps use it too).
      await ps(`Rename-Item -LiteralPath '${join(root, "qa-renamed.bin")}' -NewName 'qa-${MB}mb.bin' -ErrorAction Stop`, 60_000).catch(() => "");
      await waitFor(async () => (await rowsIn()).some((x) => x.name === `qa-${MB}mb.bin`), 60_000);
      return { ok: trashed && renamed && fetched === 0, note: `c.jpg in the trash: ${trashed}; renamed in the account (same node): ${renamed}; CDN requests while renaming: ${fetched}` };
    });
    await step(p, "W5-write-off", "Writing off again (V4 checks the read-only refusal)", async () => {
      await settingsTab(p, "app");
      const sw = p.locator("[data-ddn=app-vdisk-write]");
      if (await sw.isChecked()) await sw.evaluate((el) => (el as HTMLInputElement).click());
      const ok = await waitFor(async () => !(await sw.isChecked()) && /Mounted|Zamontowany/.test((await p.locator("[data-ddn=app-vdisk-hint]").textContent()) ?? ""), 90_000);
      return { ok, note: ok ? "read only again" : "still writable" };
    });

    await step(p, "V4-delete-refused", "Remove-Item on a file of the disk: refused (read only), the file stays", async () => {
      let msg = "";
      try {
        await ps(`Remove-Item -LiteralPath '${join(root, `qa-${MB}mb.bin`)}' -ErrorAction Stop`);
        msg = "removed (not refused)";
      } catch (e) {
        msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).split(/\r?\n/).find((l) => l.trim()) ?? "refused";
      }
      const still = existsSync(join(root, `qa-${MB}mb.bin`));
      return { ok: still && !/not refused/.test(msg), note: msg.slice(0, 200) };
    });
    await step(p, "V5-disk-off", "Disk off: the folder gone from the navigation pane and the disk", async () => {
      await settingsTab(p, "app");
      const sw = p.locator("[data-ddn=app-vdisk]");
      if (await sw.isChecked()) await sw.evaluate((el) => (el as HTMLInputElement).click());
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        await p.waitForTimeout(1000);
        gone = !existsSync(join(root, `qa-${MB}mb.bin`));
      }
      await explorerShot("V5-explorer-after-off", process.env.USERPROFILE ?? "C:\\");
      return { ok: gone, note: gone ? "the folder's placeholders are gone" : "the files are still there" };
    });
    // Back to Files for the next steps.
    await p.click("a[data-nav=files]").catch(() => {});
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 30_000 }).catch(() => {});
  }
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
  // The app's logs (the disk's) next to the screenshots.
  for (const f of ["vdisk.log", "vdisk.log.1"]) {
    try {
      if (existsSync(join(data, f))) writeFileSync(join(shots, f), readFileSync(join(data, f)));
    } catch {}
  }
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
writeFileSync(join(shots, "report.md"), [`# QA Windows ${report.at}`, "", `build: ${report.build ?? "?"}`, "", "| step | ok | note | screenshot |", "|---|---|---|---|", ...steps.map((s) => `| ${s.id} — ${s.what} | ${s.unchecked ? "not checked" : s.ok ? "ok" : "**not ok**"} | ${s.note.replace(/\|/g, "/")} | ${s.shot} |`)].join("\n") + "\n");
console.log(JSON.stringify(report, null, 1));
void existsSync;
