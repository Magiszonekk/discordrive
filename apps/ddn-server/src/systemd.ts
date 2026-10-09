// systemd --user unit for the instance (Node from its full path).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PACKAGE_DIR, REPO_DIR, UNIT_NAME } from "./config.js";

export function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", UNIT_NAME);
}

export function unitText(dataDir: string, nodePath = process.execPath): string {
  return `# Written by \`discordrive setup\`. Edit with: discordrive setup
[Unit]
Description=discordrive-next instance (metadata-only)
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${nodePath} --disable-warning=ExperimentalWarning ${join(PACKAGE_DIR, "bin", "discordrive.mjs")} serve --data-dir ${dataDir}
Restart=on-failure
# The bind address may not exist yet at boot (e.g. a VPN interface): retry.
RestartSec=5
UMask=0077
NoNewPrivileges=yes
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function sc(...args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function systemdAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    sc("--version");
    return true;
  } catch {
    return false;
  }
}

export function unitState(): { installed: boolean; active: string; enabled: string } {
  const q = (cmd: string) => {
    try {
      return sc(cmd, UNIT_NAME);
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? "").trim() || "unknown";
    }
  };
  return { installed: existsSync(unitPath()), active: q("is-active"), enabled: q("is-enabled") };
}

/** Write (if changed), daemon-reload, enable, (re)start. */
export function installAndStart(dataDir: string): { written: boolean; restarted: boolean } {
  const p = unitPath();
  const text = unitText(dataDir);
  const old = existsSync(p) ? readFileSync(p, "utf8") : null;
  mkdirSync(join(p, ".."), { recursive: true });
  if (old !== text) writeFileSync(p, text);
  sc("daemon-reload");
  sc("enable", UNIT_NAME);
  const wasActive = unitState().active === "active";
  sc(wasActive ? "restart" : "start", UNIT_NAME);
  return { written: old !== text, restarted: wasActive };
}

export function lingerEnabled(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const user = process.env.USER ?? execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    return execFileSync("loginctl", ["show-user", user, "-p", "Linger"], { encoding: "utf8" }).trim() === "Linger=yes";
  } catch {
    return null;
  }
}
