// Linux: when to ask the system key store (keyring) for the device keys, and when not.
// Asking it (Electron's safeStorage) on a system without a default keyring makes gnome-keyring open its own
// window ("Choose password for new keyring", no app name in it); a locked one asks to unlock it. The app
// explains first, remembers a refusal (the keys then stay in an owner-only file, as on a system without any
// keyring) and never asks again unless the user turns it back on. Keys already sealed by the keyring always
// need it: without it they cannot be opened (then the window shows "The keyring is locked").
import { existsSync, openSync, readSync, closeSync } from "node:fs";

/** "ask": use the keyring when it works (default); "file": the user said no, keep the keys in a file. */
export type KeyringChoice = "ask" | "file";

/** How keys.bin is protected now: "S" sealed by the keyring, "P" plain file, null no keys yet. */
export function keysProtection(file: string): "S" | "P" | null {
  if (!existsSync(file)) return null;
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(5);
    if (readSync(fd, b, 0, 5, 0) < 5 || b.subarray(0, 4).toString() !== "DDNK") return null;
    const c = String.fromCharCode(b[4]!);
    return c === "S" || c === "P" ? c : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * What to do at start:
 *  - "file": do not touch the keyring (the user refused it, or it is not Linux-relevant: never for sealed keys);
 *  - "explain": tell the user first (the keyring will open a window to create a keyring), then ask;
 *  - "check": ask the keyring directly (it exists; a locked one asks to unlock, which the user expects).
 */
export function keyringPlan(o: { platform: NodeJS.Platform; choice: KeyringChoice; keys: "S" | "P" | null; defaultKeyring: boolean | null }): "file" | "explain" | "check" {
  if (o.platform !== "linux") return "check";
  if (o.keys === "S") return "check";
  if (o.choice === "file") return "file";
  // No default keyring (or no secret service answer): the keyring would open its "create" window.
  return o.defaultKeyring === false ? "explain" : "check";
}

/**
 * Does the session's secret service have a default keyring? Asks D-Bus (gdbus) for the "default" alias:
 * "/" = none. null: no answer (no secret service, no gdbus).
 */
export async function hasDefaultKeyring(run: (cmd: string, args: string[]) => Promise<string>): Promise<boolean | null> {
  try {
    const out = await run("gdbus", ["call", "--session", "--timeout", "3", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.ReadAlias", "default"]);
    const m = /objectpath '([^']*)'/.exec(out);
    if (!m) return null;
    return m[1] !== "/";
  } catch {
    return null;
  }
}
