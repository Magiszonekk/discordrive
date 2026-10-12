// `discordrive supervise`: what the background start runs where no service manager restarts the
// drive (Windows Task Scheduler, XDG autostart). Runs `serve` as a child process, appends its
// output to <dataDir>/discordrive.log (rotated at 5 MB), restarts it after a crash with a back-off
// (2 s doubling to 60 s, reset after 10 minutes of uptime), and stops it on SIGTERM/SIGINT/SIGBREAK.
// A pid file (<dataDir>/supervisor.pid) lets `uninstall-autostart` stop it.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_FILE, command, pidFile } from "./autostart.js";
import { REPO_DIR, type InstanceConfig } from "./config.js";
import { t } from "./i18n.js";

const MAX_LOG = 5 * 1024 * 1024;

export function backoffMs(failures: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, failures - 1));
}

export async function supervise(c: InstanceConfig): Promise<void> {
  const log = join(c.dataDir, LOG_FILE);
  if (existsSync(log) && statSync(log).size > MAX_LOG) renameSync(log, `${log}.1`);
  const out = createWriteStream(log, { flags: "a", mode: 0o600 });
  const say = (s: string) => out.write(`${new Date().toISOString()} [supervise] ${s}\n`);
  writeFileSync(pidFile(c.dataDir), String(process.pid));
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    say("stopping");
    if (child && child.exitCode === null) child.kill("SIGTERM");
    else finish();
  };
  const finish = () => {
    rmSync(pidFile(c.dataDir), { force: true });
    out.end(() => process.exit(0));
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"] as const) process.on(sig, stop);
  let failures = 0;
  const [node, ...args] = command(c.dataDir, "serve");
  const startOne = () => {
    const t0 = Date.now();
    say(`starting: serve --data-dir ${c.dataDir}`);
    child = spawn(node!, ["--disable-warning=ExperimentalWarning", ...args], { cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NODE_ENV: "production" } });
    child.stdout!.pipe(out, { end: false });
    child.stderr!.pipe(out, { end: false });
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return finish();
      failures = Date.now() - t0 > 10 * 60_000 ? 1 : failures + 1;
      const wait = backoffMs(failures);
      say(t("sv.restart", { code: String(code ?? signal), s: Math.round(wait / 1000) }));
      setTimeout(startOne, wait);
    });
  };
  startOne();
  await new Promise(() => {});
}
