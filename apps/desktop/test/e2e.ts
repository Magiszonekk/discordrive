// End to end in the real desktop app (Electron, driven by Playwright): first start → "This computer only"
// (terms, the built-in instance) → account (no code to type) → a channel on a fake Discord (HTTPS + HTTP/2)
// → upload dropped from disk by the agent → download straight to disk → the window closed while a download
// runs: the agent finishes it → the app quit and started again: the same account opens, sign-up is closed.
// Then a second app with its own data: "Connect to a server" (a wrong address first, then a real instance
// that wants an invite), account, channel, a round trip through disk.
// Linux CI runs it under xvfb-run. Writes a JSON report to stdout; exit code 0 when every check passed.
//   npx tsx apps/desktop/test/e2e.ts
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-desktop-e2e-"));
const data = join(work, "data");
const downloads = join(work, "Downloads");
mkdirSync(downloads);
const r: Record<string, unknown> = {};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "k"), "-out", join(work, "c"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const fake = new FakeDiscord();
const origin = await fake.listen({ tls: { key: readFileSync(join(work, "k")), cert: readFileSync(join(work, "c"), "utf8") } });

let data2 = "";
async function launch(dataDir = data): Promise<{ app: ElectronApplication; page: Page }> {
  return launchOnce(dataDir);
}
async function launchOnce(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, ...(process.env.DDN_DESKTOP_NO_SANDBOX ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      DDN_DESKTOP_DATA: dataDir,
      DDN_DESKTOP_DOWNLOADS: downloads,
      DDN_DESKTOP_TEST_DISCORD: origin,
      DDN_DESKTOP_TEST_CA: join(work, "c"),
    } as Record<string, string>,
    timeout: 60_000,
  });
  app.process().stderr?.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n")) if (l.includes("[ddn]")) console.error(`[app] ${l.trim()}`);
  });
  const page = await app.firstWindow();
  return { app, page };
}

const step = (s: string) => console.error(`[e2e] ${s}`);
/**
 * Wait until the app's process (and its single-instance lock) is gone. Windows reports the closed
 * DevTools connection before the process has exited; a second start at that moment collides with it.
 */
async function gone(pid: number | undefined, ms = 30_000) {
  if (!pid) return;
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Its helper processes (agent, instance, GPU …) too: they keep the profile and the single-instance lock.
  if (process.platform === "win32") {
    let left = "";
    for (let i = 0; i < 150; i++) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/NH"], { encoding: "utf8" });
      left = out.split("\n").filter((l) => /electron\.exe/i.test(l)).join(" | ");
      if (!left) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    step(`after quit: main ${(() => { try { process.kill(pid, 0); return "alive"; } catch { return "gone"; } })()}, electron.exe left: ${left || "none"}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
let ok = true;
const check = (name: string, v: boolean) => {
  r[name] = v;
  if (!v) ok = false;
};

let app: ElectronApplication | null = null;
try {
  step("first start");
  let w = await launch();
  app = w.app;
  let p = w.page;
  await p.waitForSelector("[data-ddn=start-local]", { timeout: 30_000 });
  check("startPage", true);
  check("pageHasNoNode", (await p.evaluate(() => typeof (globalThis as { require?: unknown }).require === "undefined" && typeof (globalThis as { process?: unknown }).process === "undefined")) === true);
  await p.click("[data-ddn=start-local]");
  check("termsShown", await p.isVisible("[data-ddn=start-terms]"));
  await p.click("[data-ddn=start-accept]");

  step("account on the built-in instance");
  await p.waitForSelector("[data-ddn=create]", { timeout: 60_000 });
  check("inviteFieldHidden", !(await p.isVisible("[data-ddn=invite]")));
  await p.fill("[data-ddn=device-name]", "e2e desktop");
  await p.click("[data-ddn=create]");
  await p.waitForSelector("[data-ddn-ui=onboarding]:not([hidden]) [data-ddn=webhook-url]", { timeout: 60_000 });
  await p.fill("[data-ddn=webhook-url]", fake.addWebhook("1550000000000000501").url);
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-ddn=kit-dialog][open]", { timeout: 60_000 });
  await p.check("[data-ddn=kit-ack]");
  await p.click("[data-ddn=kit-done]");
  await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 30_000 });
  // Two more channels through the core (faster uploads; same path as the Settings page).
  for (const ch of ["1550000000000000502", "1550000000000000503"]) await p.evaluate((u) => (window as unknown as { ddnCore: { addWebhook(u: string): Promise<void> } }).ddnCore.addWebhook(u), fake.addWebhook(ch).url);
  const caps = await p.evaluate(() => (window as unknown as { ddnCore: { capabilities(): Promise<unknown> } }).ddnCore.capabilities());
  r.capabilities = caps;
  check("coreInAgent", (caps as { platform?: string }).platform === "desktop");

  step("upload from disk through the window: the queue shows progress while it runs");
  const big = randomBytes(64 * 1024 * 1024 + 11);
  const src = join(work, "src");
  mkdirSync(join(src, "photos"), { recursive: true });
  writeFileSync(join(src, "movie.bin"), big);
  writeFileSync(join(src, "photos", "a.txt"), "a");
  writeFileSync(join(src, "photos", "b.txt"), "bb");
  // Slow posts so the queue is seen mid-way (the fake answers every post after 1.5 s).
  fake.postDelayMs = 1500;
  const t0 = Date.now();
  // The file picker of the Files page: in the app the agent reads the picked file from disk by its path.
  await p.setInputFiles("[data-ddn=file]", join(src, "movie.bin"));
  await p.waitForSelector("[data-ddn-ui=queue]:not([hidden]) [data-ddn=queue-item]", { timeout: 30_000 });
  // While it runs: a row per file with a percentage between 1 and 99, a bar that moved, a speed.
  const mid = await p
    .waitForFunction(
      () => {
        const li = document.querySelector<HTMLElement>("[data-ddn=queue-item]");
        const st = li?.querySelector(".qstate")?.textContent ?? "";
        const pct = Number(/^(\d+)%$/.exec(st)?.[1] ?? "-1");
        const bar = parseFloat(li?.querySelector<HTMLElement>(".bar i")?.style.width ?? "0");
        const speed = li?.querySelector("[data-ddn=queue-speed]")?.textContent ?? "";
        const meta = document.querySelector("[data-ddn=queue-meta]")?.textContent ?? "";
        return pct > 0 && pct < 100 && bar > 0 && /MB\/s/.test(speed) ? { pct, bar, speed, meta, name: li!.querySelector(".qname")?.textContent } : null;
      },
      null,
      { timeout: 60_000, polling: 100 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  r.queueMidUpload = mid;
  check("pickerUploadShowsProgress", !!mid && mid.name === "movie.bin");
  await p.waitForFunction(() => document.querySelector("[data-ddn=queue-item] .qstate")?.classList.contains("done"), null, { timeout: 120_000 });
  r.upload = { ms: Date.now() - t0 };
  check("pickerUploadDone", true);

  // Drag and drop of files from disk: the File objects of a real file chooser (they carry their paths for
  // the preload), dropped on the Files page. One queue row per file, all done.
  fake.postDelayMs = 0;
  await p.evaluate(() => {
    const i = document.createElement("input");
    i.type = "file";
    i.multiple = true;
    i.id = "e2e-drop-src";
    i.hidden = true;
    document.body.append(i);
  });
  await p.setInputFiles("#e2e-drop-src", [join(src, "photos", "a.txt"), join(src, "photos", "b.txt")]);
  await p.evaluate(() => {
    const i = document.getElementById("e2e-drop-src") as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of i.files!) dt.items.add(f);
    document.querySelector("[data-page=files]")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    i.remove();
  });
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=queue-item] .qname")].some((x) => x.textContent === "b.txt"), null, { timeout: 30_000 }).catch(() => null);
  const dropRows = await p.$$eval("[data-ddn=queue-item] .qname", (e) => e.map((x) => x.textContent));
  r.dropRows = dropRows;
  check("dropQueued", dropRows.includes("a.txt") && dropRows.includes("b.txt"));
  await p.waitForFunction(() => [...document.querySelectorAll("[data-ddn=queue-item] .qstate")].every((x) => x.classList.contains("done")), null, { timeout: 60_000 }).catch(() => null);
  check("dropDone", await p.evaluate(() => [...document.querySelectorAll("[data-ddn=queue-item] .qstate")].every((x) => x.classList.contains("done"))));
  // A dropped folder (through the agent: the window cannot build a folder drop) keeps its structure.
  await p.evaluate((paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<unknown> } }).ddnCore.uploadPaths(paths), [join(src, "photos")]);
  const rows = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { id: string; name: string; kind: string }[] }> } }).ddnCore.list())).rows;
  check("listed", rows.some((x) => x.name === "movie.bin") && rows.some((x) => x.name === "photos" && x.kind === "folder"));
  const movie = rows.find((x) => x.name === "movie.bin")!;

  step("the Safe: create it in the window, Upload files from disk (the agent reads them by path), a queue row each");
  {
    await p.evaluate(() => {
      history.pushState(null, "", "/safe");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForSelector("[data-ddn=safe-new]:not([hidden])", { timeout: 15_000 });
    const SPW = "e2e safe password horse staple";
    await p.fill("[data-ddn=safe-new-pw]", SPW);
    await p.fill("[data-ddn=safe-new-pw2]", SPW);
    await p.check("[data-ddn=safe-new-ack]");
    await p.click("[data-ddn=safe-create]");
    await p.waitForSelector("[data-ddn=safe-open]:not([hidden])", { timeout: 60_000 });
    writeFileSync(join(src, "tajne.pdf"), randomBytes(300_000));
    await p.setInputFiles("[data-ddn=safe-file]", [join(src, "tajne.pdf"), join(src, "photos", "a.txt")]);
    const safeDone = await p
      .waitForFunction(() => {
        const rows = [...document.querySelectorAll("[data-ddn=safe-row]")].map((x) => x.textContent ?? "");
        const q = [...document.querySelectorAll("[data-ddn=safe-queue-item] .qstate")];
        return rows.some((x) => x.includes("tajne.pdf")) && rows.some((x) => x.includes("a.txt")) && q.length === 2 && q.every((x) => x.classList.contains("done"));
      }, null, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    r.safeRows = await p.$$eval("[data-ddn=safe-row]", (e) => e.map((x) => x.textContent?.trim()));
    r.safeQueue = await p.$$eval("[data-ddn=safe-queue-item]", (e) => e.map((x) => x.textContent?.trim()));
    check("safeUploadFromWindow", safeDone);
    const sizes = await p.evaluate(() => (window as unknown as { ddnCore: { safeList(): Promise<{ name: string; size: number | null }[]> } }).ddnCore.safeList());
    check("safeUploadSizes", sizes.some((x) => x.name === "tajne.pdf" && x.size === 300_000) && sizes.some((x) => x.name === "a.txt" && x.size === 1));
    // The Drive does not see it (the Safe's files are not in the account's log).
    const drive = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { name: string }[] }> } }).ddnCore.list())).rows;
    check("safeNotInDrive", !drive.some((x) => x.name === "tajne.pdf"));
    await p.click("[data-ddn=safe-close]");
    await p.waitForSelector("[data-ddn=safe-locked]:not([hidden])", { timeout: 10_000 });
    await p.evaluate(() => {
      history.pushState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
  }

  step("speed test through the agent: the result card, Copy, nothing left in the account or on Discord");
  {
    const files0 = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: unknown[] }> } }).ddnCore.list())).rows.length;
    const msgs0 = fake.messages.size;
    await p.evaluate(() => {
      history.pushState(null, "", "/settings/network");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForSelector("[data-ddn=speed-run]", { state: "visible", timeout: 15_000 });
    await p.click("[data-ddn=speed-adv] summary");
    await p.fill("[data-ddn=speed-count]", "6");
    await p.fill("[data-ddn=speed-size]", "1");
    await p.check("[data-ddn=speed-noline]");
    await p.click("[data-ddn=speed-run]");
    const card = await p.waitForSelector("[data-ddn=speed-card]:not([hidden])", { timeout: 120_000 }).then(() => true).catch(() => false);
    const up = (await p.textContent("[data-ddn=speed-up]").catch(() => "")) ?? "";
    const where = (await p.textContent("[data-ddn=speed-build]").catch(() => "")) ?? "";
    await app.evaluate(({ clipboard }) => clipboard.writeText("before"));
    await p.click("[data-ddn=speed-copy]");
    await p.waitForTimeout(500);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    const files = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: unknown[] }> } }).ddnCore.list())).rows.length - files0;
    r.speedTestDetail = { card, up, where, copied: copied.slice(0, 40), files, msgs: fake.messages.size - msgs0 };
    check("speedTest", card && /MB\/s/.test(up) && /desktop/i.test(where) && /discordrive speed test/.test(copied) && files === 0 && fake.messages.size === msgs0);
    await p.evaluate(() => {
      history.pushState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForSelector("[data-page=files]:not([hidden])");
  }

  step("desktop texts and Show in folder");
  {
    const t = await p.evaluate(() => ({
      notes: [...document.querySelectorAll<HTMLElement>(".uploads > .hint")].map((x) => x.textContent ?? ""),
    }));
    r.panelNotes = t.notes;
    check("panelNotesNoTab", t.notes.length >= 2 && t.notes.every((x) => !/\btab\b|kart/i.test(x)));
    await p.evaluate(() => {
      history.pushState(null, "", "/settings/app");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForFunction(() => /\d/.test(document.querySelector("[data-ddn=diag-version]")?.textContent ?? ""), null, { timeout: 15_000 });
    const ver = (await p.textContent("[data-ddn=diag-version]")) ?? "";
    r.diagVersion = ver;
    check("diagVersionNoFalseReload", !/reload|przeładuj|odśwież/i.test(ver));
    await p.evaluate(() => {
      history.pushState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForSelector("[data-page=files]:not([hidden])");
    // A download through the row button: the panel's finished entry has a visible "Show in folder".
    await p.locator(`[data-ddn=row][data-id="${movie.id}"] [data-ddn=download]`).click();
    const btn = await p.waitForSelector("[data-ddn=dl-show-btn]", { state: "visible", timeout: 120_000 }).then(() => true).catch(() => false);
    const label = btn ? ((await p.textContent("[data-ddn=dl-show-btn]")) ?? "") : "";
    const nameLooksClickable = await p.evaluate(() => getComputedStyle(document.querySelector("[data-ddn=dl-show]")!).cursor === "pointer").catch(() => false);
    r.showInFolder = { btn, label, nameLooksClickable };
    // The download made here is removed again (a later step checks the name of its own download).
    await p.waitForFunction(() => document.querySelectorAll("[data-ddn=dl-item]").length > 0);
    for (const f of readdirSync(downloads)) if (f.startsWith("movie")) (await import("node:fs")).rmSync(join(downloads, f), { force: true });
    check("showInFolderVisible", btn && /Show in folder|Pokaż w folderze/.test(label) && nameLooksClickable);
  }

  step("settings tabs: an address per tab; the desktop app card under App, no browser card; the update link");
  {
    await p.evaluate(() => {
      history.pushState(null, "", "/settings#desktop-app");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForFunction(() => location.pathname === "/settings/app", null, { timeout: 10_000 });
    await p.waitForSelector("[data-ddn=settings-tab][data-tab=app][aria-current=page]", { timeout: 10_000 });
    const app = await p.waitForSelector("[data-ddn=app-section]", { state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    const browserHidden = await p.isHidden("[data-ddn=browser-section]");
    const channelsHidden = await p.isHidden("#channels");
    await p.click("[data-ddn=settings-tab][data-tab=channels]");
    await p.waitForSelector("[data-ddn=settings-tab][data-tab=channels][aria-current=page]");
    const channels = await p.waitForSelector("#channels", { state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    await p.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
    const back = await p.waitForFunction(() => location.pathname === "/settings/app", null, { timeout: 5000 }).then(() => true).catch(() => false);
    await p.waitForTimeout(450);
    // The layout does not move with the tab (the app window: 1200 px wide by default, around the rail breakpoint).
    const boxes: string[] = [];
    for (const tab of ["channels", "account", "storage", "network", "appearance", "app"]) {
      await p.click(`[data-ddn=settings-tab][data-tab=${tab}]`);
      await p.waitForSelector(`[data-ddn=settings-tab][data-tab=${tab}][aria-current=page]`);
      await p.waitForTimeout(150);
      boxes.push(
        await p.evaluate(() => {
          window.scrollTo(0, 0);
          const t = document.querySelector("[data-ddn=settings-tabs]")!.getBoundingClientRect();
          const first = [...document.querySelectorAll("[data-page=settings] .sections > section")].find((x) => (x as HTMLElement).offsetParent !== null)!.getBoundingClientRect();
          return [t.left, t.top, t.width, t.height, first.left, first.top, first.width].map(Math.round).join(",");
        }),
      );
    }
    const layoutStable = boxes.every((b) => b.split(",").every((v, i) => Math.abs(Number(v) - Number(boxes[0]!.split(",")[i])) <= 1));
    check("settingsLayoutStable", layoutStable);
    await p.click("[data-ddn=settings-tab][data-tab=app]");
    await p.waitForSelector("[data-ddn=settings-tab][data-tab=app][aria-current=page]");
    await p.click("[data-ddn=settings-tab][data-tab=channels]");
    await p.waitForSelector("[data-ddn=settings-tab][data-tab=channels][aria-current=page]");
    r.settingsLayout = { boxes, width: await p.evaluate(() => window.innerWidth) };
    r.settingsTabsDetail = { app, browserHidden, channelsHidden, channels, back, path: await p.evaluate(() => location.pathname) };
    check("settingsTabs", app && browserHidden && channelsHidden && channels && back);
    await p.evaluate(() => {
      history.pushState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await p.waitForSelector("[data-page=files]:not([hidden])");
  }

  step("back / forward: the mouse's side buttons (mouseup 3/4; Windows: the window's app-command)");
  {
    const path = () => p.evaluate(() => location.pathname);
    const photos = rows.find((x) => x.name === "photos")!;
    await p.waitForSelector(`[data-ddn=row][data-id="${photos.id}"]`, { timeout: 30_000 });
    await p.locator(`[data-ddn=row][data-id="${photos.id}"] td.size`).click();
    await p.waitForFunction((id) => location.pathname === `/folder/${id}`, photos.id);
    const inFolder = await path();
    const mouse = (button: number) => p.evaluate((b) => window.dispatchEvent(new MouseEvent("mouseup", { button: b, bubbles: true })), button);
    await mouse(3);
    const afterBack = await p.waitForFunction(() => location.pathname === "/", null, { timeout: 5000 }).then(() => path()).catch(() => path());
    await p.waitForTimeout(450); // one step per 400 ms (both paths can fire for one press on Windows)
    await mouse(4);
    const afterForward = await p.waitForFunction((f) => location.pathname === f, inFolder, { timeout: 5000 }).then(() => path()).catch(() => path());
    await p.waitForTimeout(450);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit("app-command", {}, "browser-backward"));
    const afterCmdBack = await p.waitForFunction(() => location.pathname === "/", null, { timeout: 5000 }).then(() => path()).catch(() => path());
    await p.waitForTimeout(450);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit("app-command", {}, "browser-forward"));
    const afterCmdForward = await p.waitForFunction((f) => location.pathname === f, inFolder, { timeout: 5000 }).then(() => path()).catch(() => path());
    r.mouseNav = { inFolder, afterBack, afterForward, afterCmdBack, afterCmdForward };
    check("mouseBackForward", inFolder.startsWith("/folder/") && afterBack === "/" && afterForward === inFolder && afterCmdBack === "/" && afterCmdForward === inFolder);
    await p.click("[data-ddn=up]");
    await p.waitForFunction(() => location.pathname === "/");
  }

  step("transfer log of the agent: file events and the build");
  await p.evaluate(() => (window as unknown as { ddnCore: { setTransferLog(on: boolean): Promise<unknown> } }).ddnCore.setTransferLog(true));
  writeFileSync(join(src, "log.bin"), randomBytes(3 * 1024 * 1024));
  await p.evaluate((paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<unknown> } }).ddnCore.uploadPaths(paths), [join(src, "log.bin")]);
  const logFile = (await p.evaluate(async () => {
    const f = await (window as unknown as { ddnCore: { transferLogFile(): Promise<{ data: Blob; gz: boolean }> } }).ddnCore.transferLogFile();
    const buf = await f.data.arrayBuffer();
    return { gz: f.gz, b64: btoa(String.fromCharCode(...new Uint8Array(buf))) };
  })) as { gz: boolean; b64: string };
  const raw = Buffer.from(logFile.b64, "base64");
  const lines = (logFile.gz ? gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ev: string; build?: string; src?: string });
  const evs = new Set(lines.map((l) => l.ev));
  const head = lines.find((l) => l.ev === "log_header");
  r.logBuild = head?.build;
  check("logHasFileEvents", ["file_start", "frag", "req", "file_end"].every((e) => evs.has(e)) && lines.every((l) => l.src === "agent"));
  check("buildNotDev", !!head?.build && head.build !== "dev" && /^\d+\.\d+\.\d+\+[0-9a-f]{8}(\.g[0-9a-f]{7})?$/.test(head.build));

  step("copy: the rescue kit lands in the system clipboard (the window has no clipboard permission)");
  {
    await app.evaluate(({ clipboard }) => clipboard.writeText("e2e-before"));
    const kit = (await p.evaluate(() => (window as unknown as { ddnCore: { rescueKit(): Promise<{ kit: string }> } }).ddnCore.rescueKit())) as { kit: string };
    // The same button as the user: Settings → rescue kit → Copy.
    await p.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-ddn="kit-text"]');
      if (ta) ta.value = "";
    });
    await p.evaluate((k) => {
      document.querySelector<HTMLTextAreaElement>('[data-ddn="kit-text"]')!.value = k;
      document.querySelector<HTMLDialogElement>('[data-ddn="kit-dialog"]')?.showModal();
      document.querySelector<HTMLButtonElement>('[data-ddn="kit-copy"]')!.click();
    }, kit.kit);
    let clip = "";
    for (let i = 0; i < 50 && clip !== kit.kit; i++) {
      await new Promise((res) => setTimeout(res, 100));
      clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    }
    const failToast = await p.evaluate(() => [...document.querySelectorAll(".toast, [data-ddn=toast]")].some((x) => /copy manually|ręcznie/i.test(x.textContent ?? "")));
    r.copy = { kitChars: kit.kit.length, clipboardMatches: clip === kit.kit, failToast };
    check("copyToClipboard", clip === kit.kit && kit.kit.startsWith("ddn-kit") && !failToast);
    await p.evaluate(() => document.querySelector<HTMLDialogElement>('[data-ddn="kit-dialog"]')?.close());
  }

  step("media in the window: video plays and seeks, previews (image, PDF, text, audio) through app://");
  {
    const mdir = join(work, "media");
    mkdirSync(mdir, { recursive: true });
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });
    // 20 s of VP9 at a high bitrate (~10 MB: more than one 4 MiB window, so seeking needs a second Range).
    ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=20", "-c:v", "libvpx-vp9", "-b:v", "4M", "-deadline", "realtime", "-cpu-used", "8", join(mdir, "clip.webm")]);
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libopus", join(mdir, "tone.ogg")]);
    ff(["-f", "lavfi", "-i", "testsrc2=size=800x600", "-frames:v", "1", join(mdir, "pic.png")]);
    writeFileSync(join(mdir, "note.txt"), "Zażółć gęślą jaźń\nline 2\n");
    // A one-page PDF (hand-written, valid xref).
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"];
    let pdf = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => ((offs[i] = pdf.length), (pdf += `${i + 1} 0 obj\n${o}\nendobj\n`)));
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    writeFileSync(join(mdir, "doc.pdf"), pdf);
    const names = ["clip.webm", "tone.ogg", "pic.png", "note.txt", "doc.pdf"];
    await p.evaluate((paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<unknown> } }).ddnCore.uploadPaths(paths), names.map((n) => join(mdir, n)));
    const all = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { id: string; name: string; size: number }[] }> } }).ddnCore.list())).rows;
    const row = (n: string) => all.find((x) => x.name === n)!;
    await p.evaluate(() => location.reload());
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 });
    // tsx names inner functions with a helper the page does not have.
    await p.evaluate("window.__name = (f) => f");

    // Video formats: each one through the real player (the row's Play button), play, seek to the middle and to
    // the end. MP4 as phones and cameras write it (moov at the END: the player asks for the file's last bytes
    // first), MP4 faststart, HEVC (phones), and a large file (many 10 MiB fragments).
    const vids: { name: string; args: string[]; dur: number; expectPlay: boolean | "decoder" }[] = [
      { name: "clip.webm", args: [], dur: 20, expectPlay: true },
      { name: "h264-moov-end.mp4", args: ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"], dur: 20, expectPlay: true },
      { name: "h264-faststart.mp4", args: ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4M", "-pix_fmt", "yuv420p", "-movflags", "+faststart"], dur: 20, expectPlay: true },
      { name: "hevc.mp4", args: ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=10", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"], dur: 10, expectPlay: "decoder" },
    ];
    // Large: ~520 MB H.264 (moov at the end), 52 fragments. Generated once (noise does not compress).
    const bigMb = Number(process.env.DDN_E2E_BIG_MB ?? 520);
    if (bigMb > 0) vids.push({ name: "big-moov-end.mp4", args: ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${Math.ceil((bigMb * 8) / 40)}`, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "40M", "-maxrate", "40M", "-bufsize", "80M", "-x264-params", "nal-hrd=cbr", "-pix_fmt", "yuv420p"], dur: Math.ceil((bigMb * 8) / 40), expectPlay: true });
    for (const v of vids) if (v.args.length) ff([...v.args, join(mdir, v.name)]);
    await p.evaluate((paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<unknown> } }).ddnCore.uploadPaths(paths), vids.filter((v) => v.args.length).map((v) => join(mdir, v.name)));
    const all2 = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { id: string; name: string; size: number }[] }> } }).ddnCore.list())).rows;
    await p.evaluate(() => location.reload());
    await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 });
    await p.evaluate("window.__name = (f) => f");
    const formats: Record<string, unknown> = {};
    for (const v of vids) {
      const f = all2.find((x) => x.name === v.name)!;
      await p.waitForSelector(`[data-ddn=row][data-id="${f.id}"]`, { timeout: 30_000 });
      // The row's Play button, as the user does (it opens the player dialog).
      const play = p.locator(`[data-ddn=row][data-id="${f.id}"] [data-ddn=play]`);
      const t0 = Date.now();
      if (await play.count()) await play.click();
      else await p.evaluate(({ id, size }) => { const el = document.querySelector<HTMLVideoElement>('[data-ddn="player"]')!; el.src = `./ddn/file/${encodeURIComponent(id)}?size=${size}`; document.querySelector<HTMLDialogElement>('[data-ddn-ui="player-dialog"]')!.showModal(); void el.play().catch(() => {}); }, { id: f.id, size: f.size });
      const res = await p.evaluate(async (want) => {
        const el = document.querySelector<HTMLVideoElement>('[data-ddn="player"]')!;
        el.muted = true;
        const t0 = performance.now();
        const until = (cond: () => boolean, ms: number) => new Promise<boolean>((res) => { const tick = () => (cond() ? res(true) : el.error || performance.now() - t0 > ms ? res(false) : setTimeout(tick, 100)); tick(); });
        const meta = await until(() => el.readyState >= 1, 90_000);
        const metaMs = Math.round(performance.now() - t0);
        await el.play().catch(() => {});
        const playing = meta && (await until(() => el.currentTime > 0.3, 60_000));
        const seek = async (to: number) => {
          el.currentTime = to;
          const ok = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 60_000); el.addEventListener("seeked", () => (clearTimeout(t), res(true)), { once: true }); });
          return ok && Math.abs(el.currentTime - to) < 1.5 && el.readyState >= 2;
        };
        const mid = playing ? await seek(want / 2) : false;
        const end = playing ? await seek(Math.max(0, want - 1)) : false;
        const msg = document.querySelector('[data-ddn="player-msg"]:not([hidden])')?.textContent ?? null;
        // Contrast of the message on the player's background, in this theme and the other one (WCAG >= 4.5).
        const lum = (c: string) => {
          const cv = document.createElement("canvas").getContext("2d")!;
          cv.fillStyle = c;
          cv.fillRect(0, 0, 1, 1);
          const [r, g, b] = cv.getImageData(0, 0, 1, 1).data;
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        const contrast = () => {
          const why = document.querySelector<HTMLElement>('[data-ddn="player-why"]');
          if (!why || !msg) return null;
          const a = lum(getComputedStyle(why).color);
          const bg = lum(getComputedStyle(document.querySelector('[data-ddn-ui="player-dialog"]')!).backgroundColor);
          return Math.round(((Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05)) * 10) / 10;
        };
        const root = document.documentElement;
        const was = root.dataset.theme;
        root.dataset.theme = "light";
        const cLight = contrast();
        root.dataset.theme = "dark";
        const cDark = contrast();
        if (was) root.dataset.theme = was;
        const out = { meta, metaMs, duration: el.duration, playing, mid, end, error: el.error?.code ?? null, message: msg, offersDownload: !!document.querySelector('[data-ddn="player-msg"]:not([hidden]) [data-ddn="player-download"]'), contrast: { light: cLight, dark: cDark } };
        el.pause();
        return out;
      }, v.dur);
      await p.evaluate(() => document.querySelector<HTMLDialogElement>('[data-ddn-ui="player-dialog"]')?.close());
      formats[v.name] = { ...res, size: f.size, wallMs: Date.now() - t0 };
      if (v.expectPlay === true) check(`video_${v.name}`, res.playing && res.mid && res.end && Math.abs(res.duration - v.dur) < 1.5);
      // HEVC: plays where the platform has a decoder; where it does not, the player must say so and offer the download.
      else check(`video_${v.name}`, (res.playing && res.mid) || (!!res.message && res.offersDownload));
      if (res.message) check(`video_${v.name}_messageReadable`, (res.contrast.light ?? 0) >= 4.5 && (res.contrast.dark ?? 0) >= 4.5);
      if (v.expectPlay === true) check(`video_${v.name}_noMessage`, !res.message);
    }
    r.videoFormats = formats;
    const clip = all2.find((x) => x.name === "clip.webm")!;
    // Range answers straight from the protocol handler: 206 with Content-Range, a window, not the whole file.
    const head = await p.evaluate(async ({ id, size }) => {
      const res = await fetch(`./ddn/file/${encodeURIComponent(id)}?size=${size}`, { headers: { range: `bytes=${size - 100}-` } });
      return { status: res.status, cr: res.headers.get("content-range"), len: (await res.arrayBuffer()).byteLength };
    }, { id: clip.id, size: clip.size });
    r.videoRange = head;
    check("rangeAnswer206", head.status === 206 && head.len === 100 && head.cr === `bytes ${clip.size - 100}-${clip.size - 1}/${clip.size}`);

    // Previews: open each file's preview (the row's preview button) and wait until it is ready.
    const pv: Record<string, unknown> = {};
    const open = async (n: string) => {
      await p.evaluate(() => document.querySelector<HTMLButtonElement>('[data-ddn="preview-close"]')?.click());
      await p.locator(`[data-ddn=row][data-id="${row(n).id}"] td.size`).click();
      return p.waitForSelector(`[data-ddn=preview-dialog][open][data-file="${n}"][data-state=ready]`, { timeout: 60_000 }).then(() => true).catch(() => false);
    };
    pv.image = (await open("pic.png")) && (await p.$eval("[data-ddn=preview-img]", (i) => (i as HTMLImageElement).naturalWidth === 800).catch(() => false));
    pv.text = (await open("note.txt")) && (await p.textContent("[data-ddn=preview-text]").catch(() => "")) === "Zażółć gęślą jaźń\nline 2\n";
    pv.pdf = (await open("doc.pdf")) && (await p.$eval("[data-ddn=preview-pdf]", (f) => (f as HTMLIFrameElement).src.startsWith("blob:")).catch(() => false));
    pv.audio = (await open("tone.ogg")) && (await p.evaluate(async () => {
      const a = document.querySelector<HTMLAudioElement>("[data-ddn=preview-audio]");
      if (!a) return false;
      if (a.readyState < 1) await new Promise((res) => (a.addEventListener("loadedmetadata", res, { once: true }), a.addEventListener("error", res, { once: true }), setTimeout(res, 20_000)));
      return a.readyState >= 1 && a.duration > 2.5 && !a.error;
    }));
    pv.video = (await open("clip.webm")) && (await p.evaluate(async () => {
      const v = document.querySelector<HTMLVideoElement>("[data-ddn=preview-video]");
      if (!v) return false;
      if (v.readyState < 1) await new Promise((res) => (v.addEventListener("loadedmetadata", res, { once: true }), v.addEventListener("error", res, { once: true }), setTimeout(res, 20_000)));
      return v.readyState >= 1 && !v.error;
    }));
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('[data-ddn="preview-close"]')?.click());
    r.previews = pv;
    for (const [k, v] of Object.entries(pv)) check(`preview_${k}`, v === true);
  }

  step("download to disk");
  const d1 = (await p.evaluate((id) => (window as unknown as { ddnCore: { downloadToDisk(id: string): Promise<unknown> } }).ddnCore.downloadToDisk(id), movie.id)) as { path: string };
  check("downloadedToDisk", d1.path === join(downloads, "movie.bin") && sha(readFileSync(d1.path)) === sha(big));

  step("window closed while downloading: the agent finishes");
  fake.cdnBytesPerSec = 20 * 1024 * 1024;
  await p.evaluate((id) => void (window as unknown as { ddnCore: { downloadToDisk(id: string): Promise<unknown> } }).ddnCore.downloadToDisk(id).catch(() => {}), movie.id);
  await new Promise((res) => setTimeout(res, 800));
  await p.close();
  const second = join(downloads, "movie (1).bin");
  const until = Date.now() + 60_000;
  while (!existsSync(second) && Date.now() < until) await new Promise((res) => setTimeout(res, 300));
  fake.cdnBytesPerSec = 0;
  check("agentFinishedWithWindowClosed", existsSync(second) && sha(readFileSync(second)) === sha(big));
  check("appStillRunning", (await app.evaluate(({ app: a }) => a.isReady())) === true);

  step("quit and start again");
  // Nothing runs any more (the tray says idle): Quit does not ask.
  const idle = await app.evaluate(async ({ BrowserWindow: _ }) => {
    const g = globalThis as unknown as { __ddnBusy?: () => boolean };
    for (let i = 0; i < 50 && g.__ddnBusy?.(); i++) await new Promise((r) => setTimeout(r, 100));
    return !g.__ddnBusy?.();
  });
  check("idleAfterTransfers", idle);
  const pid = app.process().pid;
  await app.evaluate(({ app: a }) => {
    a.quit();
  });
  await app.waitForEvent("close").catch(() => null);
  await gone(pid);
  w = await launch();
  app = w.app;
  p = w.page;
  await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 });
  const rows2 = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { name: string }[] }> } }).ddnCore.list())).rows;
  check("reopenedSameAccount", rows2.some((x) => x.name === "movie.bin"));
  const cfg = await p.evaluate(() => (window as unknown as { DDN_CONFIG: { serverUrl: string } }).DDN_CONFIG);
  const health = (await (await fetch(`${cfg.serverUrl}/v1/health`)).json()) as { signup: string };
  check("signupClosedAfterFirstAccount", health.signup === "closed");
  check("noPartialFiles", readdirSync(downloads).every((f) => !f.endsWith(".ddnpart")));
  r.downloads = readdirSync(downloads);

  const pid1 = app.process().pid;
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  await gone(pid1);
  app = null;

  step("keys sealed by a keyring that is not there now: a screen with the reason, retry and the kit");
  // Linux only: Windows and macOS always have their key store (DPAPI, Keychain), so there the case is a
  // store that refuses, covered by keyring.test.ts.
  if (process.platform === "linux") {
    // The first app's data with keys.bin marked as sealed by the keyring (the CI runner has none: the app
    // runs on the file store, as with a locked keyring whose unlock was cancelled).
    const dataL = join(work, "data-locked");
    const { cpSync } = await import("node:fs");
    cpSync(data, dataL, { recursive: true });
    const kb = join(dataL, "agent", "keys.bin");
    const raw = readFileSync(kb);
    writeFileSync(kb, Buffer.concat([Buffer.from("DDNKS"), raw.subarray(5)]));
    // The test's "keyring": file until the user unlocks it (written to "os" below), with a sealer that
    // opens what it sealed (the agent's sealing goes through the main process: plain Electron safeStorage
    // with basic_text works on the runner).
    const ksFile = join(work, "keystore-state");
    writeFileSync(ksFile, "file");
    process.env.DDN_DESKTOP_TEST_KEYSTORE_FILE = ksFile;
    const wl = await launch(dataL);
    const errs: string[] = [];
    wl.page.on("pageerror", (e) => errs.push(String(e)));
    const shown = await wl.page.waitForSelector("[data-ddn=keys-locked]:not([hidden])", { timeout: 60_000 }).then(() => true).catch(() => false);
    const why = (await wl.page.textContent("[data-ddn=keys-locked-why]").catch(() => "")) ?? "";
    const retry = await wl.page.isVisible("[data-ddn=keys-locked-retry]");
    const kit = await wl.page.isVisible("[data-ddn=keys-locked-kit]");
    await wl.page.click("[data-ddn=keys-locked-retry]");
    await wl.page.waitForTimeout(800);
    const stillShown = await wl.page.isVisible("[data-ddn=keys-locked]");
    await wl.page.click("[data-ddn=keys-locked-kit]");
    const kitScreen = await wl.page.waitForSelector("[data-ddn=rescue-dialog]:not([hidden])", { timeout: 10_000 }).then(() => true).catch(() => false);
    // Back to the locked screen (the rescue kit is a way, not a must).
    await wl.page.evaluate(() => {
      history.pushState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await wl.page.waitForSelector("[data-ddn=keys-locked]:not([hidden])", { timeout: 10_000 }).catch(() => {});
    // N1: the keyring unlocked after the start: Try again now opens the account, without a restart.
    // (Sealed keys here: re-seal the copy with the keyring the app will use, so it can open them.)
    // Sealed the way the test key store does (DDN_DESKTOP_TEST_KEYSTORE_FILE: a stand-in for a keyring).
    const plainKeys = readFileSync(kb).subarray(5);
    const sealed = Buffer.from(plainKeys.map((x) => x ^ 0x5a)).toString("base64");
    const sealedOk = true;
    if (sealed) writeFileSync(kb, Buffer.concat([Buffer.from("DDNKS"), Buffer.from(sealed, "base64")]));
    writeFileSync(ksFile, "os");
    await wl.page.click("[data-ddn=keys-locked-retry]");
    const opened = await wl.page.waitForSelector("[data-page=files]:not([hidden])", { timeout: 60_000 }).then(() => true).catch(() => false);
    writeFileSync(ksFile, "file");
    r.keysLocked = { shown, why, retry, kit, stillShown, kitScreen, sealedOk, opened, errors: errs };
    check("keysLockedScreen", shown && /key store/.test(why) && retry && kit && stillShown && kitScreen && errs.length === 0);
    check("keysLockedRetryOpens", !sealedOk || opened);
    const pidL = wl.app.process().pid;
    await wl.app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await wl.app.close().catch(() => {});
    await gone(pidL);
  }

  step("second app, 'Connect to a server': a remote instance (invite only)");
  const srv = new DdnServer({ signup: "invite", rateLimits: false });
  const { url } = await srv.listen(0, "127.0.0.1");
  const invite = srv.invites.create().code;
  data2 = join(work, "data2");
  w = await launch(data2);
  app = w.app;
  p = w.page;
  await p.waitForSelector("[data-ddn=start-remote]", { timeout: 30_000 });
  await p.click("[data-ddn=start-remote]");
  await p.fill("[data-ddn=start-url]", "http://127.0.0.1:9");
  await p.click("[data-ddn=start-connect]");
  await p.waitForSelector("[data-ddn=start-remote-err]:not([hidden])", { timeout: 30_000 });
  check("remoteBadAddressShown", (await p.textContent("[data-ddn=start-remote-err]"))!.includes("cannot reach"));
  await p.fill("[data-ddn=start-url]", url);
  await p.click("[data-ddn=start-connect]");
  await p.waitForSelector("[data-ddn=create]", { timeout: 60_000 });
  check("remoteInviteFieldShown", await p.isVisible("[data-ddn=invite]"));
  await p.fill("[data-ddn=invite]", invite);
  await p.fill("[data-ddn=device-name]", "e2e remote");
  await p.click("[data-ddn=create]");
  await p.waitForSelector("[data-ddn-ui=onboarding]:not([hidden]) [data-ddn=webhook-url]", { timeout: 60_000 });
  await p.fill("[data-ddn=webhook-url]", fake.addWebhook("1550000000000000601").url);
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-ddn=kit-dialog][open]", { timeout: 60_000 });
  await p.check("[data-ddn=kit-ack]");
  await p.click("[data-ddn=kit-done]");
  await p.waitForSelector("[data-page=files]:not([hidden])", { timeout: 30_000 });
  const small = randomBytes(12 * 1024 * 1024 + 5);
  writeFileSync(join(src, "remote.bin"), small);
  const up2 = (await p.evaluate((paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<{ files: number }> } }).ddnCore.uploadPaths(paths), [join(src, "remote.bin")])) as { files: number };
  const rows3 = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { id: string; name: string }[] }> } }).ddnCore.list())).rows;
  const rb = rows3.find((x) => x.name === "remote.bin")!;
  const d3 = (await p.evaluate((id) => (window as unknown as { ddnCore: { downloadToDisk(id: string): Promise<{ path: string }> } }).ddnCore.downloadToDisk(id), rb.id)) as { path: string };
  check("remoteRoundTrip", up2.files === 1 && sha(readFileSync(d3.path)) === sha(small));
  // The server holds the account's log, never names: the same account would open in a browser.
  const accounts = Number((srv.db.prepare("SELECT COUNT(*) n FROM accounts").get() as { n: number }).n);
  check("remoteAccountOnServer", accounts === 1);
  await srv.close();
} catch (e) {
  r.error = String((e as Error)?.stack ?? e);
  ok = false;
} finally {
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  await fake.close();
}
r.ok = ok;
console.log(JSON.stringify(r, null, 1));
process.exit(ok ? 0 : 1);
