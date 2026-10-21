// Start at log-on. Windows and macOS: Electron's login item (registry Run key / login items);
// Linux: an XDG autostart entry (~/.config/autostart/<id>.desktop), the place every desktop environment
// reads. The app starts hidden (`--hidden`): only the tray icon and the agent.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoginItems {
  setLoginItemSettings(s: { openAtLogin: boolean; args?: string[]; path?: string }): void;
  getLoginItemSettings(o?: { args?: string[]; path?: string }): { openAtLogin: boolean };
}

export interface AutostartEnv {
  platform: NodeJS.Platform;
  /** The program to start (Linux: $APPIMAGE when run as an AppImage, else process.execPath). */
  exec: string;
  /** XDG_CONFIG_HOME or ~/.config. */
  configHome?: string;
  appId: string;
  appName: string;
  login?: LoginItems;
}

export const HIDDEN_ARG = "--hidden";

export function xdgFile(env: AutostartEnv): string {
  return join(env.configHome ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", `${env.appId}.desktop`);
}

/** Desktop Entry Exec quoting (spec: double quotes around arguments with reserved characters). */
function execQuote(s: string): string {
  return /[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
}

export function xdgEntry(env: AutostartEnv): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${env.appName}`,
    `Exec=${execQuote(env.exec)} ${HIDDEN_ARG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function setAutostart(env: AutostartEnv, on: boolean): void {
  if (env.platform === "linux") {
    const f = xdgFile(env);
    if (on) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, xdgEntry(env), { mode: 0o644 });
    } else rmSync(f, { force: true });
    return;
  }
  env.login?.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG], path: env.exec });
}

export function autostartOn(env: AutostartEnv): boolean {
  if (env.platform === "linux") {
    const f = xdgFile(env);
    return existsSync(f) && readFileSync(f, "utf8").includes(`${HIDDEN_ARG}`);
  }
  return !!env.login?.getLoginItemSettings({ args: [HIDDEN_ARG], path: env.exec }).openAtLogin;
}
