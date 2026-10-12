// Real run of the backend without a service manager (Linux XDG autostart / the Windows task uses
// the same `supervise`): register → the drive answers → killed server is restarted by supervise →
// `start` says "already running in the background" → uninstall stops it and removes the entry.
// Isolated: own XDG_CONFIG_HOME, data directory and port; the real service is not touched.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const BIN = join(__dirname, "..", "bin", "discordrive.mjs");
const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}
async function waitHealth(port: number, ok: boolean, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const up = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.ok, () => false);
    if (up === ok) return;
    if (Date.now() - t0 > ms) throw new Error(`health ${ok ? "up" : "down"} timeout`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(process.platform === "win32")("background start without a service manager (XDG autostart + supervise)", () => {
  it("setup --autostart registers and starts; a crash is restarted; start refuses; uninstall removes", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-xdg-"));
    const env = { XDG_CONFIG_HOME: join(root, "cfg"), DISCORDRIVE_AUTOSTART_BACKEND: "xdg", DISCORDRIVE_NO_AUTOSTART: "", DISCORDRIVE_NO_SYSTEMD: "", CI: "1" };
    const data = join(root, "data");
    const port = await freePort();
    // On failure: never leave a supervisor behind.
    onTestFinished(() => void run(["uninstall-autostart", "--data-dir", data], env));
    const s = run(["setup", "--yes", "--accept-risk", "--autostart", "--port", String(port), "--data-dir", data], env);
    expect(s.status, s.stdout + s.stderr).toBe(0);
    expect(s.stdout).toContain("background start registered and started");
    expect(s.stdout).toContain("npm run uninstall-autostart");
    const entry = join(root, "cfg", "autostart", "discordrive-next.desktop");
    expect(readFileSync(entry, "utf8")).toMatch(/Exec=.* supervise --data-dir /);
    await waitHealth(port, true);
    const sup = Number(readFileSync(join(data, "supervisor.pid"), "utf8"));
    // The server (child of supervise) dies: supervise starts it again.
    // (its other child is tsx's esbuild service: pick the one running `serve`)
    const serverPid = execFileSync("pgrep", ["-P", String(sup), "-f", "discordrive.mjs serve"], { encoding: "utf8" }).trim().split("\n")[0]!;
    process.kill(Number(serverPid), "SIGKILL");
    await waitHealth(port, false, 5000).catch(() => {});
    await waitHealth(port, true, 30_000);
    expect(readFileSync(join(data, "discordrive.log"), "utf8")).toMatch(/the drive stopped \(code SIGKILL\); restarting in 2 s/);
    const st = run(["start", "--data-dir", data], env);
    expect(st.status).toBe(1);
    expect(st.stderr).toContain("already running in the background (starts when you log in to the desktop)");
    const d = run(["doctor", "--data-dir", data], env);
    expect(d.stdout).toMatch(/OK\s+background start: XDG autostart: supervise pid \d+/);
    const u = run(["uninstall-autostart", "--data-dir", data], env);
    expect(u.stdout).toContain("Background start removed");
    expect(existsSync(entry)).toBe(false);
    await waitHealth(port, false, 10_000);
    expect(existsSync(join(data, "supervisor.pid"))).toBe(false);
    expect(run(["uninstall-autostart", "--data-dir", data], env).stdout).toContain("No background start was registered.");
  }, 120_000);
});
