// "Run the drive automatically in the background": one interface, a backend per system.
//   Linux    systemd --user unit (as before; linger is only reported). Without systemd: an XDG
//            autostart entry (~/.config/autostart/discordrive-next.desktop, starts after the
//            desktop login) that runs `discordrive supervise`.
//   Windows  Task Scheduler task for the current user ("at log on", no administrator rights,
//            LeastPrivilege), registered with `schtasks /Create /XML`. The action is
//            `conhost.exe --headless node discordrive.mjs supervise`: no console window.
//   macOS    LaunchAgent (~/Library/LaunchAgents/discordrive-next.plist, RunAtLoad, KeepAlive).
// `supervise` (cli.ts) runs `serve` as a child, restarts it after a crash with a back-off and
// appends its output to <dataDir>/discordrive.log; systemd and launchd restart by themselves.
// Why Task Scheduler and not the Startup folder or a Windows service: packages/sync-core/DECISIONS.md.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { PACKAGE_DIR, REPO_DIR } from "./config.js";
import { installAndStart as systemdInstall, lingerEnabled, systemdAvailable, unitPath, unitState } from "./systemd.js";

export type Backend = "systemd" | "xdg" | "windows-task" | "launchd" | "none";
export const TASK_NAME = "discordrive-next";
export const LAUNCHD_LABEL = "discordrive-next";
export const LOG_FILE = "discordrive.log";

export interface AutostartState {
  backend: Backend;
  installed: boolean;
  /** Running now (as far as the backend can tell); null = cannot tell. */
  running: boolean | null;
  /** Where it is registered (file path or task name), for messages. */
  where: string;
  /** Raw backend detail for doctor (systemd: "active, enabled"; task: "Running"). */
  detail: string;
}

const off = (v: string | undefined) => !!v && v !== "0";

/** Which backend this machine uses. DISCORDRIVE_NO_AUTOSTART=1 (or the older _NO_SYSTEMD) turns it off. */
export function detectBackend(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, hasSystemd: () => boolean = systemdAvailable): Backend {
  if (off(env.DISCORDRIVE_NO_AUTOSTART) || off(env.DISCORDRIVE_NO_SYSTEMD)) return "none";
  const forced = env.DISCORDRIVE_AUTOSTART_BACKEND as Backend | undefined;
  if (forced && ["systemd", "xdg", "windows-task", "launchd", "none"].includes(forced)) return forced;
  if (platform === "win32") return "windows-task";
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return hasSystemd() ? "systemd" : "xdg";
  return "none";
}

/** The command the backends run: [node, script, ...args]. */
export function command(dataDir: string, sub: "serve" | "supervise", nodePath = process.execPath): string[] {
  return [nodePath, join(PACKAGE_DIR, "bin", "discordrive.mjs"), sub, "--data-dir", dataDir];
}

// ── Windows: Task Scheduler XML ────────────────────────────────────────────────

export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** One argument for a Windows command line (CommandLineToArgvW rules). */
export function winQuote(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Task for the current user: at log on, only while the user is logged on (InteractiveToken,
 * no stored password, no administrator rights), LeastPrivilege, no time limit, restarted by the
 * scheduler if the start fails, one instance. conhost --headless gives node a console without
 * a window (Windows 10 1809+).
 */
export function windowsTaskXml(o: { user: string; nodePath: string; dataDir: string; repoDir?: string; systemRoot?: string; script?: string }): string {
  const sys = o.systemRoot ?? "C:\\Windows";
  const script = o.script ?? join(PACKAGE_DIR, "bin", "discordrive.mjs");
  const args = ["--headless", o.nodePath, script, "supervise", "--data-dir", o.dataDir].map(winQuote).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>discordrive-next: runs the drive in the background after you log on. Written by \`npm run setup\`; remove with \`npm run uninstall-autostart\`.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(o.user)}</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(o.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(`${sys}\\System32\\conhost.exe`)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(o.repoDir ?? REPO_DIR)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16 LE with a BOM: what schtasks /XML reads without guessing. */
export const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\n/g, "\r\n"), "utf16le")]);

export function windowsUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.USERNAME || userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

// ── macOS: LaunchAgent plist ───────────────────────────────────────────────────

export function launchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function launchdPlist(o: { nodePath: string; dataDir: string; repoDir?: string; script?: string }): string {
  const args = [o.nodePath, o.script ?? join(PACKAGE_DIR, "bin", "discordrive.mjs"), "serve", "--data-dir", o.dataDir];
  const log = join(o.dataDir, LOG_FILE);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`npm run setup\` (discordrive-next); remove with \`npm run uninstall-autostart\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.repoDir ?? REPO_DIR)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

// ── Linux without systemd: XDG autostart entry ─────────────────────────────────

export function xdgAutostartPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "autostart", "discordrive-next.desktop");
}

/** Desktop Entry `Exec` quoting: arguments with special characters in "…", \ " ` $ escaped, % doubled. */
export function desktopExecArg(a: string): string {
  const s = a.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`=]/.test(s)) return s;
  return `"${s.replace(/([\\"`$])/g, "\\$1")}"`;
}

export function xdgDesktopEntry(o: { nodePath: string; dataDir: string; script?: string }): string {
  const exec = [o.nodePath, o.script ?? join(PACKAGE_DIR, "bin", "discordrive.mjs"), "supervise", "--data-dir", o.dataDir].map(desktopExecArg).join(" ");
  return `[Desktop Entry]
Type=Application
Name=discordrive-next
Comment=Runs the discordrive-next drive in the background after you log in (npm run setup; remove: npm run uninstall-autostart)
Exec=${exec}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

// ── pid files (supervise / serve), to stop what a backend without a service manager started ──

export const pidFile = (dataDir: string) => join(dataDir, "supervisor.pid");
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function supervisorPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile(dataDir), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}
async function stopSupervisor(dataDir: string): Promise<boolean> {
  const pid = supervisorPid(dataDir);
  if (!pid) return false;
  try {
    // Windows has no SIGTERM: process.kill() would end only the supervisor and orphan the
    // server. taskkill /T ends the whole tree (supervise + serve + its helpers).
    if (process.platform === "win32") run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGTERM");
  } catch {
    /* gone already */
  }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return true;
}

/** Start `supervise` detached from this terminal (XDG "start now", tests). */
export function spawnSupervisor(dataDir: string): void {
  const [node, ...args] = command(dataDir, "supervise");
  const child = spawn(node!, args, { cwd: REPO_DIR, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, NODE_ENV: "production" } });
  child.unref();
}

// ── the interface ──────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

export function state(dataDir: string, backend: Backend = detectBackend()): AutostartState {
  switch (backend) {
    case "systemd": {
      const u = unitState();
      return { backend, installed: u.installed, running: u.active === "active", where: unitPath(), detail: `${u.active}, ${u.enabled}` };
    }
    case "xdg": {
      const p = xdgAutostartPath();
      const pid = supervisorPid(dataDir);
      return { backend, installed: existsSync(p), running: pid !== null, where: p, detail: pid ? `supervise pid ${pid}` : "not running" };
    }
    case "windows-task": {
      try {
        // CSV: "TaskName","Next Run Time","Status"
        const line = run("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"]);
        const status = line.split(",").at(-1)?.replace(/"/g, "").trim() ?? "";
        const pid = supervisorPid(dataDir);
        return { backend, installed: true, running: status === "Running" || pid !== null, where: `Task Scheduler: \\${TASK_NAME}`, detail: status || "?" };
      } catch {
        return { backend, installed: false, running: supervisorPid(dataDir) !== null, where: `Task Scheduler: \\${TASK_NAME}`, detail: "not registered" };
      }
    }
    case "launchd": {
      const p = launchAgentPath();
      let running: boolean | null = null;
      let detail = "not loaded";
      try {
        const out = run("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`]);
        const st = /\bstate = (\w+)/.exec(out)?.[1] ?? "loaded";
        running = st === "running";
        detail = st;
      } catch {
        running = false;
      }
      return { backend, installed: existsSync(p), running, where: p, detail };
    }
    default:
      return { backend: "none", installed: false, running: null, where: "", detail: "" };
  }
}

/** Register and start now. Returns where it was registered and whether it was there before. */
export async function install(dataDir: string, backend: Backend = detectBackend()): Promise<{ where: string; replaced: boolean }> {
  switch (backend) {
    case "systemd": {
      const r = systemdInstall(dataDir);
      return { where: unitPath(), replaced: r.restarted };
    }
    case "xdg": {
      const p = xdgAutostartPath();
      const replaced = existsSync(p);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, xdgDesktopEntry({ nodePath: process.execPath, dataDir }));
      await stopSupervisor(dataDir);
      spawnSupervisor(dataDir);
      return { where: p, replaced };
    }
    case "windows-task": {
      const replaced = state(dataDir, backend).installed;
      if (replaced) {
        try {
          run("schtasks.exe", ["/End", "/TN", TASK_NAME]);
        } catch {
          /* not running */
        }
        await stopSupervisor(dataDir);
      }
      mkdirSync(dataDir, { recursive: true });
      const xml = join(dataDir, "autostart-task.xml");
      writeFileSync(xml, utf16(windowsTaskXml({ user: windowsUser(), nodePath: process.execPath, dataDir, systemRoot: process.env.SystemRoot })));
      try {
        run("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", xml, "/F"]);
      } finally {
        rmSync(xml, { force: true });
      }
      run("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
      return { where: `Task Scheduler: \\${TASK_NAME}`, replaced };
    }
    case "launchd": {
      const p = launchAgentPath();
      const replaced = existsSync(p);
      mkdirSync(join(p, ".."), { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(p, launchdPlist({ nodePath: process.execPath, dataDir }));
      try {
        run("launchctl", ["bootout", `gui/${uid()}`, p]);
      } catch {
        /* was not loaded */
      }
      run("launchctl", ["bootstrap", `gui/${uid()}`, p]);
      return { where: p, replaced };
    }
    default:
      throw new Error("autostart is not available on this system");
  }
}

/** Stop and remove. True if something was registered. */
export async function uninstall(dataDir: string, backend: Backend = detectBackend()): Promise<boolean> {
  switch (backend) {
    case "systemd": {
      const p = unitPath();
      if (!existsSync(p)) return false;
      try {
        run("systemctl", ["--user", "disable", "--now", "discordrive-next.service"]);
      } catch {
        /* not enabled / not running */
      }
      rmSync(p, { force: true });
      try {
        run("systemctl", ["--user", "daemon-reload"]);
      } catch {
        /* best effort */
      }
      return true;
    }
    case "xdg": {
      const p = xdgAutostartPath();
      const had = existsSync(p);
      rmSync(p, { force: true });
      return (await stopSupervisor(dataDir)) || had;
    }
    case "windows-task": {
      const had = state(dataDir, backend).installed;
      if (had) {
        try {
          run("schtasks.exe", ["/End", "/TN", TASK_NAME]);
        } catch {
          /* not running */
        }
        run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]);
      }
      return (await stopSupervisor(dataDir)) || had;
    }
    case "launchd": {
      const p = launchAgentPath();
      if (!existsSync(p)) return false;
      try {
        run("launchctl", ["bootout", `gui/${uid()}`, p]);
      } catch {
        /* not loaded */
      }
      rmSync(p, { force: true });
      return true;
    }
    default:
      return false;
  }
}

/** systemd only: without linger the user's services stop at log-out. */
export function lingerOff(backend: Backend): boolean {
  return backend === "systemd" && lingerEnabled() === false;
}
