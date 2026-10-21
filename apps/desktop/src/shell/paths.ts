// What the window may load: app://ddn URLs mapped to the app's own files, nothing outside them.
import { join, normalize, sep } from "node:path";

export const SCHEME = "app";
export const ORIGIN = `${SCHEME}://ddn`;

/** Is this URL one of the app's own pages? (Node's URL gives a custom scheme the origin "null": compare parts.) */
export function isAppUrl(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return u.protocol === `${SCHEME}:` && u.host === "ddn";
  } catch {
    return false;
  }
}

/**
 * The file an app:// URL maps to, or null when it would leave the app's folders. /start/… is the start
 * page (root/static); everything else is the web app of `mode` (root/web/<mode>), and a path without an
 * extension is its index.html (the web app routes with the History API: /folder/<id>, /settings, …).
 */
export function staticPath(url: string, root: string, mode: string): string | null {
  const u = new URL(url);
  if (u.host !== "ddn") return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  let base: string;
  if (p.startsWith("/start/")) {
    base = join(root, "static");
    p = p.slice("/start".length);
  } else {
    base = join(root, "web", mode);
    if (!/\.[a-z0-9]+$/i.test(p)) p = "/index.html";
  }
  const full = normalize(join(base, p));
  return full.startsWith(base + sep) ? full : null;
}
