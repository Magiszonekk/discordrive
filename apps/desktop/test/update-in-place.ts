// "Install and restart" on Windows, for real (CI, windows-latest): version A is installed with its NSIS
// installer, the user moves the desktop shortcut and adds a Start menu shortcut of their own, the app's
// data folder gets a file; then version A finds version B (a fake GitHub releases API serving B's
// installer and SHA256SUMS), downloads, checks and installs it the way the button does (silent NSIS in
// update mode in the same folder) and is started again by the installer. Checked: B's files are in place,
// the app restarted, every shortcut is where the user left it and points at the app, the default desktop
// shortcut was not created again, the Start menu shortcut is the same file (not re-made), the data stayed.
// A control run of B's installer without update mode shows the full installer's behaviour (it re-creates
// the default shortcuts).
// Taskbar pins cannot be made in CI (Windows offers no API for it); README tells how to check them by hand.
//   npx tsx apps/desktop/test/update-in-place.ts <release folder of A> <release folder of B>
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

if (process.platform !== "win32") throw new Error("Windows only");
const [relA, relB] = process.argv.slice(2);
if (!relA || !relB) throw new Error("usage: update-in-place.ts <release A> <release B>");
const exeIn = (d: string) => join(d, readdirSync(d).find((f) => f.endsWith(".exe"))!);
const infoIn = (d: string) => JSON.parse(readFileSync(join(d, "build-info.json"), "utf8")) as { commit: string; build: string };
const exeA = exeIn(relA);
const exeB = exeIn(relB);
const A = infoIn(relA);
const B = infoIn(relB);
if (A.commit === B.commit) throw new Error("A and B must be builds of different commits");

const r: Record<string, unknown> = { a: A.build, b: B.build };
const step = (s: string) => console.error(`[update] ${s}`);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const ps = (script: string) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
async function until<T>(f: () => T | null | undefined | false, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
/** Run an installer and wait for it (NSIS returns when done; a silent one shows nothing). */
function install(exe: string, args: string[]) {
  ps(`$p = Start-Process -FilePath ${q(exe)} -ArgumentList ${args.map(q).join(",")} -PassThru -Wait; exit $p.ExitCode`);
}
const lnk = (p: string) => (existsSync(p) ? (JSON.parse(ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(p)}); $i=Get-Item -LiteralPath ${q(p)}; @{target=$s.TargetPath; created=[string]$i.CreationTimeUtc.Ticks; written=[string]$i.LastWriteTimeUtc.Ticks} | ConvertTo-Json -Compress`)) as { target: string; created: string; written: string }) : null);
const makeLnk = (p: string, target: string) => ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(p)}); $s.TargetPath=${q(target)}; $s.Save()`);
const appRunning = () => /discordrive\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq discordrive.exe", "/NH"], { encoding: "utf8" }));
/** Is this build's commit inside the installed app (its build-info.json)? False while the installer writes it. */
const asarHas = (dir: string, s: string) => {
  try {
    return readFileSync(join(dir, "resources", "app.asar")).includes(Buffer.from(s));
  } catch {
    return false;
  }
};

const desktop = ps("[Environment]::GetFolderPath('Desktop')");
const programs = ps("[Environment]::GetFolderPath('Programs')");
const appData = join(process.env.APPDATA!, "discordrive");
// The app downloads the update to the user's Downloads folder.
mkdirSync(join(process.env.USERPROFILE!, "Downloads"), { recursive: true });
const defaultDesktopLnk = join(desktop, "discordrive.lnk");
const startLnk = join(programs, "discordrive.lnk");
const movedLnk = join(desktop, "My apps", "discordrive.lnk");
const ownStartLnk = join(programs, "My tools", "discordrive (mine).lnk");

// ── 1. version A, installed as a user does (the full installer, silently here) ───────────────────────
step(`install A (${A.build})`);
install(exeA, ["/S"]);
// Where it went: the folder of the uninstaller the installer registered ("…\\Uninstall discordrive.exe" /currentuser).
const uninstall = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'discordrive*' } | Select-Object -First 1).UninstallString`);
const instDir = /^"(.+)\\[^\\]+"/.exec(uninstall)?.[1] ?? "";
r.installDir = instDir;
const appExe = join(instDir, "discordrive.exe");
r.installedA = existsSync(appExe) && asarHas(instDir, A.commit);
r.defaultLinksAfterA = { desktop: !!lnk(defaultDesktopLnk), startMenu: !!lnk(startLnk) };

// ── 2. the user's shortcuts and data ──────────────────────────────────────────────────────────────────
mkdirSync(join(desktop, "My apps"), { recursive: true });
renameSync(defaultDesktopLnk, movedLnk);
mkdirSync(join(programs, "My tools"), { recursive: true });
makeLnk(ownStartLnk, appExe);
mkdirSync(appData, { recursive: true });
writeFileSync(join(appData, "keep-me.txt"), "user data");
const startBefore = lnk(startLnk);
await sleep(1500); // shortcut times have a coarse resolution: a re-made file must differ

// ── 3. A finds B, downloads, checks and installs it (as "Install and restart") ────────────────────────
const exeBytes = readFileSync(exeB);
const exeName = exeB.split(/[\\/]/).pop()!;
const sums = `${createHash("sha256").update(exeBytes).digest("hex")}  ${exeName}\n`;
const srv = createServer((req, res) => {
  const u = req.url ?? "";
  if (u === "/repos/Magiszonekk/discordrive/releases/tags/main-build")
    return res.end(
      JSON.stringify({
        body: `commit: ${B.commit}`,
        html_url: `${base}/r`,
        published_at: new Date().toISOString(),
        assets: [
          { name: exeName, browser_download_url: `${base}/a/exe`, size: exeBytes.length },
          { name: "SHA256SUMS", browser_download_url: `${base}/a/sums`, size: sums.length },
          { name: "build-info.json", browser_download_url: `${base}/a/info`, size: 0 },
        ],
      }),
    );
  if (u === "/a/exe") return res.end(exeBytes);
  if (u === "/a/sums") return res.end(sums);
  if (u === "/a/info") return res.end(JSON.stringify(B));
  res.writeHead(404).end();
});
await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const report = join(process.env.RUNNER_TEMP ?? process.env.TEMP!, "ddn-update-selftest.json");
rmSync(report, { force: true });
rmSync(join(appData, "last-update.json"), { force: true });
step("start A: check, download, install B");
const app = spawn(appExe, [], { detached: true, stdio: "ignore", env: { ...process.env, DDN_DESKTOP_UPDATES_API: base, DDN_DESKTOP_UPDATE_SELFTEST: report, DDN_DESKTOP_HIDDEN: "1" } });
app.unref();
const readReport = () => (existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as { stage: string; own: { commit: string }; argv: string[]; error?: string }) : null);
r.selftestA = await until(() => readReport(), 90_000);
step(`A: ${JSON.stringify(r.selftestA)}`);
r.installedB = !!(await until(() => existsSync(appExe) && asarHas(instDir, B.commit) && !asarHas(instDir, A.commit), 180_000, 2000));
// The installer starts the app again with --updated; it notes the build it is now.
const last = await until(() => (existsSync(join(appData, "last-update.json")) ? (JSON.parse(readFileSync(join(appData, "last-update.json"), "utf8")) as { commit: string }) : null), 120_000);
r.restartedAs = last?.commit ?? null;
r.restartedReport = readReport();
await sleep(3000);
try {
  execFileSync("taskkill", ["/IM", "discordrive.exe", "/F", "/T"], { stdio: "ignore" });
} catch {}
await until(() => !appRunning(), 30_000);
srv.close();

// ── 4. shortcuts and data after the update ────────────────────────────────────────────────────────────
const moved = lnk(movedLnk);
const start = lnk(startLnk);
const own = lnk(ownStartLnk);
const same = (p: string | undefined) => (p ?? "").toLowerCase() === appExe.toLowerCase();
r.after = {
  movedDesktopLink: moved,
  defaultDesktopLinkMadeAgain: !!lnk(defaultDesktopLnk),
  startMenuLink: start,
  startMenuLinkBefore: startBefore,
  ownStartMenuLink: own,
  dataKept: existsSync(join(appData, "keep-me.txt")) && existsSync(join(appData, "desktop-settings.json")),
};
const checks = {
  installedA: r.installedA === true,
  aFoundAndInstalledB: (r.selftestA as { stage?: string } | null)?.stage === "installing" && r.installedB === true,
  restartedAsB: r.restartedAs === B.commit,
  movedDesktopLinkKept: !!moved && same(moved.target),
  defaultDesktopLinkNotMadeAgain: !lnk(defaultDesktopLnk),
  startMenuLinkSameFile: !!start && !!startBefore && start.created === startBefore.created && start.written === startBefore.written && same(start.target),
  ownStartMenuLinkKept: !!own && same(own.target),
  dataKept: (r.after as { dataKept: boolean }).dataKept,
};
r.checks = checks;

// ── 5. control: B's installer without update mode (the full installer, as when run by hand) ───────────
step("control: full installer");
install(exeB, ["/S"]);
const startCtl = lnk(startLnk);
r.control = { defaultDesktopLinkMadeAgain: !!lnk(defaultDesktopLnk), startMenuLinkMadeAgain: !!startCtl && !!start && startCtl.created !== start.created };
try {
  execFileSync("taskkill", ["/IM", "discordrive.exe", "/F", "/T"], { stdio: "ignore" });
} catch {}

r.ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify(r, null, 1));
process.exit(r.ok ? 0 : 1);
