// The background start on the REAL backend of this system: Windows Task Scheduler (schtasks),
// macOS LaunchAgent (launchctl), Linux systemd --user. It registers a task / agent / unit for
// the current user, so it only runs when DDN_CI_REAL_AUTOSTART=1 (CI runners: .github/workflows/
// cross-platform.yml). Never on a machine with a real instance.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { TASK_NAME, detectBackend } from "../src/autostart.js";

const BIN = join(__dirname, "..", "bin", "discordrive.mjs");
const env = { ...process.env, DISCORDRIVE_NO_AUTOSTART: "", DISCORDRIVE_NO_SYSTEMD: "", CI: "1" };
const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 120_000 });
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}
async function waitHealth(port: number, ok: boolean, ms: number) {
  const t0 = Date.now();
  for (;;) {
    const up = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.ok, () => false);
    if (up === ok) return;
    if (Date.now() - t0 > ms) throw new Error(`health did not go ${ok ? "up" : "down"} in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
/** PID of the `serve` process for this data directory. */
function servePid(data: string): number | null {
  try {
    if (process.platform === "win32") {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*discordrive.mjs serve*' -and $_.CommandLine -like '*${data.replace(/'/g, "''")}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
      return out ? Number(out) : null;
    }
    const out = execFileSync("pgrep", ["-f", `discordrive.mjs serve --data-dir ${data}`], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : null;
  } catch {
    return null;
  }
}

describe.runIf(process.env.DDN_CI_REAL_AUTOSTART === "1")(`background start on the real backend (${detectBackend()})`, () => {
  it("setup --autostart → running, survives a crash, start refuses, doctor OK, uninstall stops and removes", async () => {
    const backend = detectBackend();
    expect(backend).not.toBe("none");
    const data = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? tmpdir(), "ddn-real-"));
    const port = await freePort();
    onTestFinished(() => void run(["uninstall-autostart", "--data-dir", data]));
    const s = run(["setup", "--yes", "--accept-risk", "--autostart", "--port", String(port), "--data-dir", data]);
    console.log(s.stdout, s.stderr);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain("background start registered and started");
    await waitHealth(port, true, 90_000);
    if (backend === "windows-task") {
      const xml = execFileSync("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/XML"], { encoding: "utf8" });
      expect(xml).toContain("<LogonTrigger>");
      // Windows exports the default LeastPrivilege by leaving RunLevel out: no elevation either way.
      expect(xml).not.toContain("HighestAvailable");
      expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(xml).toMatch(/conhost\.exe<\/Command>/);
      expect(xml).toMatch(/--headless/);
    }
    // Crash: the backend (supervise / launchd KeepAlive / systemd Restart=on-failure) starts it again.
    const pid = servePid(data);
    expect(pid, "serve process found").toBeTruthy();
    process.kill(pid!, process.platform === "win32" ? undefined : "SIGKILL");
    await waitHealth(port, false, 15_000).catch(() => {});
    await waitHealth(port, true, 90_000);
    expect(servePid(data)).not.toBe(pid);
    const st = run(["start", "--data-dir", data]);
    expect(st.status).toBe(1);
    expect(st.stderr).toContain("already running in the background");
    const d = run(["doctor", "--data-dir", data]);
    console.log(d.stdout);
    expect(d.stdout).toMatch(/OK\s+background start: /);
    if (backend !== "launchd" && backend !== "systemd") expect(readFileSync(join(data, "discordrive.log"), "utf8")).toContain("[supervise] starting");
    const u = run(["uninstall-autostart", "--data-dir", data]);
    expect(u.stdout).toContain("Background start removed");
    await waitHealth(port, false, 30_000);
    expect(servePid(data)).toBeNull();
  }, 300_000);
});
