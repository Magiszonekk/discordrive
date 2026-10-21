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
    for (let i = 0; i < 50; i++) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/NH"], { encoding: "utf8" });
      if (!/electron\.exe/i.test(out)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
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

  step("upload from disk (the agent reads the file)");
  const big = randomBytes(64 * 1024 * 1024 + 11);
  const src = join(work, "src");
  mkdirSync(join(src, "photos"), { recursive: true });
  writeFileSync(join(src, "movie.bin"), big);
  writeFileSync(join(src, "photos", "a.txt"), "a");
  const t0 = Date.now();
  const up = (await p.evaluate(
    (paths) => (window as unknown as { ddnCore: { uploadPaths(p: string[]): Promise<unknown> } }).ddnCore.uploadPaths(paths),
    [join(src, "movie.bin"), join(src, "photos")],
  )) as { files: number; bytes: number; failed: unknown[] };
  r.upload = { ...up, ms: Date.now() - t0 };
  check("uploadedFromDisk", up.files === 2 && up.failed.length === 0);
  await p.waitForSelector("[data-ddn=row] >> text=movie.bin", { timeout: 30_000 }).catch(() => null);
  const rows = (await p.evaluate(() => (window as unknown as { ddnCore: { list(): Promise<{ rows: { id: string; name: string; kind: string }[] }> } }).ddnCore.list())).rows;
  check("listed", rows.some((x) => x.name === "movie.bin") && rows.some((x) => x.name === "photos" && x.kind === "folder"));
  const movie = rows.find((x) => x.name === "movie.bin")!;

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
