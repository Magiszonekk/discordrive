// Fingerprint of everything that goes into apps/web-mo/dist. build.ts writes it
// to dist/build-stamp.json; `discordrive start` compares it with the sources and
// rebuilds when they differ (after a `git pull` the user would otherwise keep
// seeing the old page until a manual `npm run build -w @ddv4/web-mo`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const STAMP_FILE = "build-stamp.json";

/** Inputs of the bundle (esbuild metafile: web-mo/src + these packages + node_modules pinned by the lock file). */
const INPUTS = [
  "apps/web-mo/index.html",
  "apps/web-mo/build.ts",
  "apps/web-mo/source-hash.ts",
  "apps/web-mo/src",
  "apps/web-mo/cobalt",
  "packages/sync-core/src",
  "packages/metadata-client/src",
  "packages/processing/src",
  "packages/config/src",
  "package-lock.json",
];

function walk(abs: string, out: string[]) {
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const e of readdirSync(abs).sort()) if (e !== "node_modules" && !e.startsWith(".")) walk(join(abs, e), out);
  } else out.push(abs);
}

/** SHA-256 over (path, content) of every input file; ~1 MB of text, a few ms. */
export function sourceHash(repo = REPO): string {
  const files: string[] = [];
  for (const p of INPUTS) walk(join(repo, p), files);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(repo, f).replaceAll("\\", "/"));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}

/** Short commit of the checkout (7 chars), or null without git (a downloaded archive). */
export function gitCommit(repo = REPO): string | null {
  try {
    const c = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
    return /^[0-9a-f]{7,12}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

/** Version of the app (the instance package). */
export function appVersion(repo = REPO): string {
  try {
    return (JSON.parse(readFileSync(join(repo, "apps", "ddn-server", "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

/**
 * Build identifier shown in Settings, `/v1/health` and the transfer logs: `<version>+<source hash, 8>`
 * and `.g<commit>` when git knows it, e.g. `0.2.0+3fa94c1e.gb045e69`. No paths or host names. The
 * source hash is what decides a rebuild, so two builds with the same ID run the same code.
 */
export function buildId(hash: string, commit: string | null = gitCommit(), version = appVersion()): string {
  return `${version}+${hash.slice(0, 8)}${commit ? `.g${commit}` : ""}`;
}

/** Build ID recorded by the last build in `dist`, or null. */
export function builtId(dist: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dist, STAMP_FILE), "utf8")) as { build?: string }).build ?? null;
  } catch {
    return null;
  }
}

/** Hash recorded by the last build in `dist`, or null (no build or a build from before the stamp). */
export function builtHash(dist: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dist, STAMP_FILE), "utf8")) as { hash?: string }).hash ?? null;
  } catch {
    return null;
  }
}
