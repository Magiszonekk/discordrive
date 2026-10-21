// Settings of the desktop app itself (not of the account): which server, autostart, download folder,
// update checks. A JSON file in the app's data folder; several servers can be stored, one is active (the
// first version uses one at a time).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerEntry {
  /** "remote": an instance on the network; "local": the one built into this app ("This computer only"). */
  kind: "remote" | "local";
  /** Remote: the instance address. Local: filled in at each start (random port). */
  url: string;
  /** Mode the instance runs (from /v1/health); the app loads the web build of that mode. */
  mode: string;
  addedAt: number;
}

export interface DesktopSettings {
  v: 1;
  servers: ServerEntry[];
  /** Index into servers; -1 = not chosen yet (first start screen). */
  active: number;
  /** Start at log-on (default on). */
  autostart: boolean;
  /** Downloads go here; null = the system Downloads folder. */
  downloadsDir: string | null;
  /** Check GitHub for a newer build (default on). */
  checkUpdates: boolean;
  /** "This computer only": the terms were accepted (when). */
  localTermsAt: number | null;
}

export const DEFAULTS: DesktopSettings = { v: 1, servers: [], active: -1, autostart: true, downloadsDir: null, checkUpdates: true, localTermsAt: null };

export function settingsFile(dataDir: string): string {
  return join(dataDir, "desktop-settings.json");
}

export function loadSettings(dataDir: string): DesktopSettings {
  const f = settingsFile(dataDir);
  if (!existsSync(f)) return { ...DEFAULTS, servers: [] };
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<DesktopSettings>;
    const s: DesktopSettings = { ...DEFAULTS, ...j, v: 1, servers: Array.isArray(j.servers) ? j.servers.filter(validServer) : [] };
    if (!Number.isInteger(s.active) || s.active >= s.servers.length) s.active = s.servers.length ? 0 : -1;
    return s;
  } catch {
    return { ...DEFAULTS, servers: [] };
  }
}

export function saveSettings(dataDir: string, s: DesktopSettings): void {
  const f = settingsFile(dataDir);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

function validServer(x: unknown): x is ServerEntry {
  const s = x as ServerEntry;
  return !!s && (s.kind === "remote" || s.kind === "local") && typeof s.url === "string" && typeof s.mode === "string";
}

/**
 * The address the user typed for "Connect to a server", normalised: https:// added when no scheme,
 * path/query/hash dropped. http:// only for this computer or a private network (no TLS on a LAN box);
 * anything else must be https.
 */
export function normaliseServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("empty address");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) addresses");
  if (u.username || u.password) throw new Error("no user name or password in the address");
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) throw new Error("http:// only for this computer or a local network; use https://");
  return u.origin;
}

export function isPrivateHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host);
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
