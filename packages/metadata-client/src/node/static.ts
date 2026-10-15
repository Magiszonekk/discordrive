// Serves the built browser app (apps/web-mo/dist) from the same origin as the
// API: the service worker (video streaming) needs same origin + HTTPS.
// Everything that is not /v1/... comes here. /s/<id> (share links) and other
// unknown paths without a file extension get index.html.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface StaticOptions {
  dir: string;
  /** Extra origins the page may fetch from (Discord API/CDN; a fake in tests). */
  connectSrc: string[];
  /** Object exposed as window.DDN_CONFIG through /config.js. */
  config: Record<string, unknown>;
}

export const DISCORD_ORIGINS = ["https://discord.com", "https://cdn.discordapp.com", "https://media.discordapp.net"];

export function securityHeaders(connectSrc: string[]): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${connectSrc.join(" ")}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    // File preview (apps/web-mo/src/preview.ts): PDFs open in the browser's own viewer in an
    // <iframe src="blob:…">. Without this line frame-src falls back to default-src 'self', which
    // blocks blob: frames. blob: URLs belong to the origin that created them and hold only bytes
    // this app fetched and typed application/pdf; object-src stays 'none'; frame-ancestors 'none'.
    "frame-src 'self' blob:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  };
}

export class StaticSite {
  private readonly cache = new Map<string, { mtime: number; body: Buffer; etag: string }>();
  private readonly headers: Record<string, string>;
  constructor(private readonly o: StaticOptions) {
    this.headers = securityHeaders(o.connectSrc);
  }

  private load(file: string): { body: Buffer; etag: string } | null {
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const hit = this.cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const body = readFileSync(file);
    const v = { mtime: st.mtimeMs, body, etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"` };
    this.cache.set(file, v);
    return v;
  }

  /** True if handled. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (path === "/config.js") {
      const body = Buffer.from(`window.DDN_CONFIG=${JSON.stringify(this.o.config)};\n`);
      res.writeHead(200, { ...this.headers, "content-type": TYPES[".js"]!, "cache-control": "no-cache", "content-length": body.length });
      return void res.end(req.method === "HEAD" ? undefined : body), true;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return false;
    }
    if (rel === "/" || rel.startsWith("/s/") || (!extname(rel) && !rel.startsWith("/v1"))) rel = "/index.html";
    const root = normalize(this.o.dir + sep);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) return false;
    const f = this.load(file);
    if (!f) return false;
    const h: Record<string, string | number> = {
      ...this.headers,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      etag: f.etag,
    };
    // The service worker must be allowed to control the whole origin.
    if (rel === "/sw.js") h["service-worker-allowed"] = "/";
    // The second CDN connection (web-mo src/lane.ts) runs in a sandboxed iframe of this app: only this
    // page may be framed, and only by this origin (every other page stays frame-ancestors 'none' / DENY).
    if (rel === "/lane.html") {
      h["content-security-policy"] = String(h["content-security-policy"]).replace("frame-ancestors 'none'", "frame-ancestors 'self'");
      h["x-frame-options"] = "SAMEORIGIN";
    }
    if (req.headers["if-none-match"] === f.etag) {
      res.writeHead(304, h);
      return void res.end(), true;
    }
    h["content-length"] = f.body.length;
    res.writeHead(200, h);
    res.end(req.method === "HEAD" ? undefined : f.body);
    return true;
  }
}
