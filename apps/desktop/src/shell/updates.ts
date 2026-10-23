// Update check of the desktop app. Nothing is installed without the user's click: CI publishes the build of
// every change on `main` as one pre-release ("main-build", replaced each time) with the installers and
// SHA256SUMS; the app asks GitHub (no token, at most every few hours), and when that build is from another
// commit than its own it says so (tray, About). "Download" fetches the installer for this system to the
// Downloads folder and checks its SHA-256 against SHA256SUMS (a mismatch is refused and the file deleted).
// Then "Install and restart" (Windows, AppImage) updates this copy in place: the app closes, the NSIS
// installer runs silently in update mode in the same folder (shortcuts are kept, not created again) and
// starts the app again; an AppImage file is replaced by the new one. A .deb is installed by the user (apt).
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, createReadStream, createWriteStream, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  // A network that never answers: give up after 20 s (the check runs again later).
  const r = await f(`${apiBase}/repos/${REPO}/releases/tags/${CHANNEL_TAG}`, { headers: { accept: "application/vnd.github+json", "user-agent": "discordrive-desktop" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { body?: string; html_url?: string; published_at?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
  const assets = (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const info = assets.find((a) => a.name === "build-info.json");
  let commit = "";
  let build = "";
  if (info) {
    const ir = await f(info.url, { headers: { "user-agent": "discordrive-desktop" }, signal: AbortSignal.timeout(20_000) });
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

/** "0.1.313+abc.gdef" / "0.1.313" → [0, 1, 313]; null when it has no x.y.z. */
export function buildNumber(build: string | null | undefined): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(build ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is that build a newer one than this copy? A dev run never is. Both have a version (x.y.z: the commit count):
 * newer only when its version is higher; a lower one is an older build (a copy built from a branch ahead of
 * the release), never offered. The same version or none on one side: newer when the commit differs.
 */
export function isNewer(own: { commit: string | null; build?: string | null; version?: string | null }, b: AvailableBuild | null): boolean {
  if (!b || !own.commit) return false;
  if (b.commit.startsWith(own.commit.slice(0, 7)) || own.commit.startsWith(b.commit.slice(0, 7))) return false;
  const mine = buildNumber(own.build) ?? buildNumber(own.version);
  const theirs = buildNumber(b.build);
  if (mine && theirs) {
    for (let i = 0; i < 3; i++) if (theirs[i] !== mine[i]) return theirs[i]! > mine[i]!;
  }
  return true;
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

/** What to tell the user after the download (nothing is installed until they click). */
export function installHint(kind: InstallKind, path: string, inPlace: boolean): string {
  switch (kind) {
    case "deb":
      return inPlace
        ? "Install and restart: the system asks for your password, the package is installed (your data stays) and the app starts again."
        : `in a terminal: ${debTerminalCommand(path)} — then start the app again`;
    case "appimage":
      return inPlace
        ? "Install and restart: the app closes, this AppImage file is replaced by the new one and starts again."
        : `chmod +x ${JSON.stringify(path)} — then start the new file (and remove the old one)`;
    case "nsis":
      return inPlace
        ? "Install and restart: the app closes, the new version is installed in the same folder (your shortcuts and pins stay where they are) and the app starts again. Running the downloaded file yourself opens the full installer."
        : "Run the installer (Windows SmartScreen may warn: More info → Run anyway).";
    default:
      return "Open the downloaded file.";
  }
}

/**
 * Can "Install and restart" update this copy in place? Windows (NSIS) always; an AppImage when its folder
 * is writable (the file is replaced next to itself); a .deb never (apt needs root).
 */
/**
 * How a .deb is installed from the app: through the system password dialog (pkexec, polkit) with dpkg, or —
 * without pkexec — the command for a terminal (sudo dpkg -i: apt and App Center refuse a file they think is
 * installed already when only the commit differs).
 */
export function debInstallCommand(file: string, pkexec: string | null): { file: string; args: string[] } | null {
  return pkexec ? { file: pkexec, args: ["dpkg", "-i", file] } : null;
}
export function debTerminalCommand(file: string): string {
  return `sudo dpkg -i ${JSON.stringify(file)}`;
}
/** pkexec on PATH (Ubuntu and most desktops have it with polkit), or null. */
export function findPkexec(path = process.env.PATH ?? ""): string | null {
  for (const d of path.split(":")) {
    if (!d) continue;
    try {
      accessSync(join(d, "pkexec"), constants.X_OK);
      return join(d, "pkexec");
    } catch {
      /* not here */
    }
  }
  return null;
}

export function canInstallInPlace(kind: InstallKind, appImage?: string, pkexec: string | null = null): boolean {
  if (kind === "nsis") return true;
  if (kind === "deb") return !!pkexec;
  if (kind !== "appimage" || !appImage) return false;
  try {
    accessSync(dirname(appImage), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * How to start the NSIS installer in update mode (electron-builder's assisted installer): `/S` silent,
 * `--updated` (an update: the old version's uninstaller keeps the shortcuts, no new ones are created, the
 * app data stays), `--force-run` (start the app when done), `/D=` the folder this copy runs from. NSIS
 * wants `/D=` last and unquoted (a path with spaces included), so the command line is passed verbatim and
 * only the installer's own path is quoted.
 */
export function nsisUpdateCommand(installer: string, installDir: string): { file: string; argv0: string; args: string[] } {
  if (/["\r\n]/.test(installer) || /["\r\n]/.test(installDir)) throw new Error("unexpected characters in a path");
  return { file: installer, argv0: `"${installer}"`, args: ["/S", "--updated", "--force-run", `/D=${installDir.replace(/[\\/]+$/, "")}`] };
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/**
 * Put the downloaded AppImage in place of the running one: copied next to it, made executable, renamed over
 * it (a rename: the running copy keeps its mounted old file, the next start gets the new one).
 */
export function replaceAppImage(downloaded: string, target: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.update`);
  try {
    copyFileSync(downloaded, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
