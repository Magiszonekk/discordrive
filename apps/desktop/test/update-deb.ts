// "Install and restart" with the .deb on Linux, for real (CI, ubuntu-latest): version A is installed with dpkg,
// the app's data folder gets a file; then A finds version B (a fake GitHub releases API serving B's .deb and
// SHA256SUMS), downloads and checks it and installs it the way the button does (dpkg -i through the elevation
// program: pkexec on a desktop; here DDN_DESKTOP_DEB_ELEVATE="sudo -n", pkexec needs a desktop session) and
// starts again. Checked: the package version grew (dpkg -s), B's files are in place, the app restarted as B,
// the data stayed.
//   npx tsx apps/desktop/test/update-deb.ts <release folder of A> <release folder of B>
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.platform !== "linux") throw new Error("Linux only");
const [relA, relB] = process.argv.slice(2);
if (!relA || !relB) throw new Error("usage: update-deb.ts <release A> <release B>");
const debIn = (d: string) => join(d, readdirSync(d).find((f) => f.endsWith(".deb"))!);
const infoIn = (d: string) => JSON.parse(readFileSync(join(d, "build-info.json"), "utf8")) as { commit: string; build: string; version: string };
const debA = debIn(relA);
const debB = debIn(relB);
const A = infoIn(relA);
const B = infoIn(relB);
if (A.commit === B.commit) throw new Error("A and B must be builds of different commits");
const step = (s: string) => console.error(`[deb] ${s}`);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until<T>(f: () => T | null | undefined | false, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const pkgVersion = () => {
  try {
    return execFileSync("dpkg-query", ["-W", "-f=${Version}", "discordrive"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const r: Record<string, unknown> = { a: { build: A.build, version: A.version }, b: { build: B.build, version: B.version } };

step(`install A (${A.version}, ${A.build})`);
execFileSync("sudo", ["apt-get", "install", "-y", "-q", debA], { stdio: "inherit" });
r.versionA = pkgVersion();
const exe = "/opt/discordrive/discordrive";
const appHas = (s: string) => {
  try {
    return readFileSync("/opt/discordrive/resources/app.asar").includes(Buffer.from(s));
  } catch {
    return false;
  }
};
r.installedA = existsSync(exe) && appHas(A.commit);
const data = join(homedir(), ".config", "discordrive");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "keep-me.txt"), "user data");

const debBytes = readFileSync(debB);
const debName = debB.split("/").pop()!;
const sums = `${createHash("sha256").update(debBytes).digest("hex")}  ${debName}\n`;
let base = "";
const srv = createServer((req, res) => {
  const u = req.url ?? "";
  if (u === "/repos/Magiszonekk/discordrive/releases/tags/main-build")
    return res.end(
      JSON.stringify({
        body: `commit: ${B.commit}`,
        html_url: `${base}/r`,
        published_at: new Date().toISOString(),
        assets: [
          { name: debName, browser_download_url: `${base}/a/deb`, size: debBytes.length },
          { name: "SHA256SUMS", browser_download_url: `${base}/a/sums`, size: sums.length },
          { name: "build-info.json", browser_download_url: `${base}/a/info`, size: 0 },
        ],
      }),
    );
  if (u === "/a/deb") return res.end(debBytes);
  if (u === "/a/sums") return res.end(sums);
  if (u === "/a/info") return res.end(JSON.stringify(B));
  res.writeHead(404).end();
});
await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const report = join(process.env.RUNNER_TEMP ?? "/tmp", "ddn-deb-selftest.json");
rmSync(report, { force: true });
rmSync(join(data, "last-update.json"), { force: true });
mkdirSync(join(homedir(), "Downloads"), { recursive: true });

step("start A: check, download, install B (dpkg -i through sudo -n)");
const app = spawn("xvfb-run", ["-a", exe, "--no-sandbox"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, DDN_DESKTOP_UPDATES_API: base, DDN_DESKTOP_UPDATE_SELFTEST: report, DDN_DESKTOP_HIDDEN: "1", DDN_DESKTOP_DEB_ELEVATE: "sudo -n" },
});
app.unref();
const readReport = () => (existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as { stage: string; error?: string }) : null);
r.selftestA = await until(() => readReport(), 120_000);
step(`A: ${JSON.stringify(r.selftestA)}`);
r.versionB = await until(() => (pkgVersion() === B.version ? pkgVersion() : null), 120_000);
r.installedB = appHas(B.commit) && !appHas(A.commit);
// The app relaunches itself with --updated after dpkg: it notes the build it is now.
const last = await until(() => (existsSync(join(data, "last-update.json")) ? (JSON.parse(readFileSync(join(data, "last-update.json"), "utf8")) as { commit: string }) : null), 90_000);
r.restartedAs = last?.commit ?? null;
await sleep(2000);
try {
  execFileSync("pkill", ["-f", "/opt/discordrive/discordrive"], { stdio: "ignore" });
} catch {}
srv.close();
r.dataKept = existsSync(join(data, "keep-me.txt"));
const checks = {
  installedA: r.installedA === true && r.versionA === A.version,
  versionGrew: execFileSync("dpkg", ["--compare-versions", B.version, "gt", A.version]).length === 0,
  aFoundAndInstalledB: (r.selftestA as { stage?: string } | null)?.stage === "installing" && r.versionB === B.version && r.installedB === true,
  restartedAsB: r.restartedAs === B.commit,
  dataKept: r.dataKept === true,
};
r.checks = checks;
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, ...r }, null, 1));
process.exit(ok ? 0 : 1);
