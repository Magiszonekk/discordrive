// Chromium's sandbox in the AppImage on Ubuntu 24.04+ (and others restricting unprivileged user
// namespaces through AppArmor): an AppImage cannot ship a setuid chrome-sandbox, and electron-builder's
// AppRun then starts the app with --no-sandbox by itself. This app does not run without the sandbox:
// it says why and offers the two ways out — the .deb (it installs an AppArmor profile), or a profile
// for the AppImage (one command, needs sudo).
import { execFileSync } from "node:child_process";

/** Can this user create user namespaces (what the sandbox needs without a setuid helper)? */
export function userNamespacesWork(): boolean {
  try {
    execFileSync("unshare", ["-Ur", "true"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** The AppImage was started without Chromium's sandbox (AppRun added --no-sandbox, or the user did). */
export function appImageWithoutSandbox(env: { platform: NodeJS.Platform; appImage?: string; noSandbox: boolean }): boolean {
  return env.platform === "linux" && !!env.appImage && env.noSandbox;
}

export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/discordrive-appimage";

/**
 * An AppArmor profile that lets the AppImage's Electron binary (mounted under /tmp/.mount_<name>…/) use
 * user namespaces, the same rule the .deb installs for /opt/discordrive/discordrive.
 */
export function appArmorCommand(): string {
  return [
    `sudo tee ${APPARMOR_PROFILE_PATH} > /dev/null <<'EOF'`,
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "profile discordrive-appimage /tmp/.mount_discor*/discordrive flags=(unconfined) {",
    "  userns,",
    "  include if exists <local/discordrive-appimage>",
    "}",
    "EOF",
    `sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`,
  ].join("\n");
}
