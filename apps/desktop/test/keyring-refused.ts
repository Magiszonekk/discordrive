// Linux, a session whose secret service has no default keyring (a fresh system): the user answers "No, keep
// the keys in a file" to the app's question, then "Connect to a server". The server must be reachable in that
// same session, without closing a keyring window or restarting by hand (before: Chromium's own password store
// opened gnome-keyring's "create" window ~10-20 s later and the main process's network waited for it).
//   dbus-run-session -- xvfb-run -a npx tsx test/keyring-refused.ts        (after npm run build)
// Starts gnome-keyring-daemon (secrets only) with an empty keyrings folder in this D-Bus session. The app is
// driven over remote debugging: it starts itself again after the answer, with the same switches.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { DdnServer } from "@ddv4/metadata-client/node";

const appDir = join(import.meta.dirname, "..");
const electronBin = (await import("electron")).default as unknown as string;
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-kr-"));
const home = join(work, "home");
mkdirSync(join(home, ".local", "share"), { recursive: true });
mkdirSync(join(work, "run"), { recursive: true, mode: 0o700 });
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CURRENT_DESKTOP: "GNOME",
  XDG_RUNTIME_DIR: join(work, "run"),
  DDN_DESKTOP_DATA: join(work, "data"),
  DDN_DESKTOP_DOWNLOADS: join(work, "dl"),
  DDN_DESKTOP_TEST_KEYRING_ANSWER: process.env.DDN_DESKTOP_TEST_KEYRING_ANSWER ?? "no",
  DDN_DESKTOP_QUIT_ON_CLOSE: "1",
};
const result: Record<string, unknown> = {};
let ok = false;
let browser: Browser | null = null;
const srv = new DdnServer({ signup: "open", rateLimits: false });
const { url } = await srv.listen(0, "127.0.0.1");
try {
  // The secret service of this session, with no keyring at all (as on a fresh system).
  delete env.GNOME_KEYRING_CONTROL;
  const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--replace"], { env, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  const alias = execFileSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.ReadAlias", "default"], { env, encoding: "utf8" }).trim();
  result.defaultKeyringBefore = alias;
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(electronBin, [appDir, `--remote-debugging-port=${port}`, ...(process.env.DDN_DESKTOP_NO_SANDBOX ? ["--no-sandbox"] : [])], { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n")) if (l.includes("[ddn]")) console.error(`[app] ${l.trim()}`);
  });
  // The first process exits after the answer; the one it starts serves the same port.
  let page: Page | undefined;
  for (let i = 0; i < 90 && !page; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    page = browser?.contexts().flatMap((c) => c.pages()).find((x) => /start\.html/.test(x.url()));
    if (!page) await browser?.close().catch(() => {});
  }
  if (!page) {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch((e) => String(e));
    throw new Error(`no start page: ${typeof b === "string" ? b.slice(0, 200) : b.contexts().flatMap((c) => c.pages()).map((x) => x.url()).join(", ")}`);
  }
  const settings = JSON.parse(readFileSync(join(work, "data", "desktop-settings.json"), "utf8")) as { keyring?: string };
  result.keyringSetting = settings.keyring;
  // The app that serves the window now is a new process (the first one exited after the answer), started
  // with --password-store=basic: Chromium off the keyring from its start. (Without the restart a session
  // with no GNOME prompter, as a CI runner, would still pass the checks below.)
  result.firstExited = child.exitCode !== null || child.signalCode !== null;
  const mains = (() => {
    try {
      return execFileSync("pgrep", ["-af", `remote-debugging-port=${port}`], { encoding: "utf8" }).split("\n").filter((l) => l && !/--type=/.test(l) && !/pgrep/.test(l));
    } catch {
      return [];
    }
  })();
  result.restartedBasic = mains.some((l) => l.includes("--password-store=basic") && !l.startsWith(`${child.pid} `));
  // The keyring's "create" window used to come 10-20 s after the answer, and the network then waited for it:
  // connect after it would have come.
  const prompter = () => {
    try {
      return execFileSync("pgrep", ["-f", "gcr-prompter|gcr4-prompter"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  let prompterSeen = 0;
  for (let i = 0; i < 40; i++) {
    prompterSeen = Math.max(prompterSeen, prompter());
    await new Promise((r) => setTimeout(r, 1000));
  }
  result.prompterBeforeConnect = prompterSeen;
  await page.click("[data-ddn=start-remote]");
  await page.fill("[data-ddn=start-url]", url);
  const t0 = Date.now();
  await page.click("[data-ddn=start-connect]");
  // Past the time the keyring window used to come up (10-20 s): the connection works in this session.
  const reached = await page
    .waitForSelector("[data-ddn=create]", { timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  result.connectMs = Date.now() - t0;
  result.reached = reached;
  if (!reached) result.error = await page.textContent("[data-ddn=start-remote-err]").catch(() => null);
  // Still fine 25 s later (the window used to come up late): another request to the server.
  await page.waitForTimeout(25_000);
  const p2 = await browser!.contexts().flatMap((c) => c.pages()).find((x) => x.url().startsWith("app:"));
  result.later = p2 ? await p2.evaluate(() => (window as unknown as { ddnCore: { status(): Promise<unknown> } }).ddnCore.status().then(() => "ok", (e) => String(e))) : "no page";
  // Did anything create a keyring? (the "create" window was never answered here, so none should exist)
  result.keyrings = existsSync(join(home, ".local", "share", "keyrings")) ? execFileSync("ls", [join(home, ".local", "share", "keyrings")], { encoding: "utf8" }).trim() : "";
  result.prompterAtEnd = prompter();
  ok = result.keyringSetting === "file" && result.firstExited === true && result.restartedBasic === true && reached && result.later === "ok" && prompterSeen === 0 && result.prompterAtEnd === 0;
  daemon.kill();
} catch (e) {
  result.error = String(e);
} finally {
  await browser?.close().catch(() => {});
  await srv.close();
  // The app started again by itself (a new process, not our child): it is found by its data folder.
  try {
    execFileSync("pkill", ["-f", `--user-data-dir=${join(work, "data")}|${electronBin} ${appDir} --remote-debugging`], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("pkill", ["-f", "gcr-prompter"], { stdio: "ignore" });
  } catch {}
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok, ...result }, null, 1));
process.exit(ok ? 0 : 1);
