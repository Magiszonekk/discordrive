// Update check of the desktop app. There is no silent update: CI publishes the build of every change on
// `main` as one pre-release ("main-build", replaced each time) with the installers and SHA256SUMS; the app
// asks GitHub (no token, at most every few hours), and when that build is from another commit than its own
// it says so (tray, About). "Download" fetches the installer for this system to the Downloads folder,
// checks its SHA-256 against SHA256SUMS (a mismatch is refused and the file deleted), then the user opens
// or runs it. Nothing is installed by the app.
import { createHash } from "node:crypto";
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "Magiszonekk/discordrive";
export const CHANNEL_TAG = "main-build";
/** Not more often than this (GitHub allows 60 unauthenticated requests per hour per IP). */
export const CHECK_EVERY_MS = 4 * 3600_000;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}
export interface AvailableBuild {
  /** Commit the build was made from (from build-info.json of the release, else the release text). */
  commit: string;
  build: string;
  publishedAt: string;
  notes: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}
export type InstallKind = "nsis" | "appimage" | "deb" | "mac-zip" | "dev";

/** How this copy was installed: decides which file "Download" fetches. */
export function installKind(env: { platform: NodeJS.Platform; appImage?: string; execPath: string; packaged: boolean }): InstallKind {
  if (!env.packaged) return "dev";
  if (env.platform === "win32") return "nsis";
  if (env.platform === "darwin") return "mac-zip";
  if (env.appImage) return "appimage";
  return "deb";
}

export function assetFor(kind: InstallKind, assets: ReleaseAsset[], arch = process.arch): ReleaseAsset | null {
  const a = arch === "x64" ? /x64|amd64|x86_64/ : new RegExp(arch);
  const pick = (re: RegExp) => assets.find((x) => re.test(x.name) && a.test(x.name)) ?? assets.find((x) => re.test(x.name)) ?? null;
  switch (kind) {
    case "nsis":
      return pick(/\.exe$/i);
    case "appimage":
      return pick(/\.AppImage$/);
    case "deb":
      return pick(/\.deb$/);
    case "mac-zip":
      return pick(/mac.*\.zip$/i);
    default:
      return null;
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The "main-build" pre-release, or null when there is none (or GitHub is unreachable / rate limited). */
export async function latestBuild(f: Fetch, apiBase = "https://api.github.com"): Promise<AvailableBuild | null> {
  const r = await f(`${apiBase}/repos/${REPO}/releases/tags/${CHANNEL_TAG}`, { headers: { accept: "application/vnd.github+json", "user-agent": "discordrive-desktop" } });
  if (!r.ok) return null;
  const j = (await r.json()) as { body?: string; html_url?: string; published_at?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
  const assets = (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const info = assets.find((a) => a.name === "build-info.json");
  let commit = "";
  let build = "";
  if (info) {
    const ir = await f(info.url, { headers: { "user-agent": "discordrive-desktop" } });
    if (ir.ok) {
      const bi = (await ir.json().catch(() => null)) as { commit?: string; build?: string } | null;
      commit = bi?.commit ?? "";
      build = bi?.build ?? "";
    }
  }
  if (!commit) commit = /commit[:\s]+([0-9a-f]{7,40})/i.exec(j.body ?? "")?.[1] ?? "";
  if (!commit) return null;
  return { commit, build, publishedAt: j.published_at ?? "", notes: j.body ?? "", htmlUrl: j.html_url ?? "", assets };
}

/** Is that build another one than this copy (different commit)? A dev run never is. */
export function isNewer(own: { commit: string | null }, b: AvailableBuild | null): boolean {
  if (!b || !own.commit) return false;
  return !b.commit.startsWith(own.commit.slice(0, 7)) && !own.commit.startsWith(b.commit.slice(0, 7));
}

/** SHA256SUMS lines → { file name: hex }. */
export function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const x = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (x) m.set(x[2]!, x[1]!.toLowerCase());
  }
  return m;
}

/**
 * Download the installer to `dir` and check it against SHA256SUMS of the same release. Returns the path;
 * throws (and deletes the file) on a mismatch or a missing sum.
 */
export async function downloadVerified(f: Fetch, b: AvailableBuild, asset: ReleaseAsset, dir: string, onProgress?: (done: number, total: number) => void): Promise<string> {
  const sumsAsset = b.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) throw new Error("the release has no SHA256SUMS");
  const sr = await f(sumsAsset.url, { headers: { "user-agent": "discordrive-desktop" } });
  if (!sr.ok) throw new Error(`SHA256SUMS: HTTP ${sr.status}`);
  const want = parseSums(await sr.text()).get(asset.name);
  if (!want) throw new Error(`no checksum for ${asset.name}`);
  const r = await f(asset.url, { headers: { "user-agent": "discordrive-desktop" } });
  if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status}`);
  const final = join(dir, asset.name);
  const part = `${final}.part`;
  const h = createHash("sha256");
  let done = 0;
  const total = Number(r.headers.get("content-length") ?? asset.size) || asset.size;
  const src = Readable.fromWeb(r.body as never);
  src.on("data", (c: Buffer) => {
    h.update(c);
    done += c.length;
    onProgress?.(done, total);
  });
  try {
    await pipeline(src, createWriteStream(part, { mode: 0o644 }));
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const got = h.digest("hex");
  if (got !== want) {
    rmSync(part, { force: true });
    throw new Error(`checksum mismatch for ${asset.name}: the file was deleted`);
  }
  renameSync(part, final);
  return final;
}

/** What to tell the user after the download (the app never installs by itself). */
export function installHint(kind: InstallKind, path: string): string {
  switch (kind) {
    case "deb":
      return `sudo apt install ${JSON.stringify(path)}`;
    case "appimage":
      return `chmod +x ${JSON.stringify(path)} — then start the new file (and remove the old one)`;
    case "nsis":
      return "Run the installer (Windows SmartScreen may warn: More info → Run anyway).";
    default:
      return "Open the downloaded file.";
  }
}
