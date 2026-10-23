// Update check against a fake GitHub releases API: a build from another commit is offered, the installer
// for this system is downloaded and its SHA-256 checked; a wrong checksum is refused and the file deleted.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetFor, canInstallInPlace, debInstallCommand, debTerminalCommand, findPkexec, downloadVerified, installHint, installKind, isNewer, buildNumber, latestBuild, nsisUpdateCommand, parseSums, replaceAppImage, sha256File, CHANNEL_TAG, REPO } from "../src/shell/updates.js";

const deb = Buffer.from("fake deb package ".repeat(1000));
const exe = Buffer.from("fake windows installer ".repeat(1000));
let sums = "";
let srv: Server;
let base = "";
let releaseStatus = 200;

beforeAll(async () => {
  srv = createServer((req, res) => {
    const u = req.url ?? "";
    if (u === `/repos/${REPO}/releases/tags/${CHANNEL_TAG}`) {
      res.writeHead(releaseStatus, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          body: "Build of main.\ncommit: 0123456789abcdef0123456789abcdef01234567",
          html_url: `${base}/r`,
          published_at: "2026-10-21T12:00:00Z",
          assets: [
            { name: "discordrive-0.1.0-linux-amd64.deb", browser_download_url: `${base}/a/deb`, size: deb.length },
            { name: "discordrive-0.1.0-win-x64.exe", browser_download_url: `${base}/a/exe`, size: exe.length },
            { name: "SHA256SUMS", browser_download_url: `${base}/a/sums`, size: 0 },
            { name: "build-info.json", browser_download_url: `${base}/a/info`, size: 0 },
          ],
        }),
      );
    }
    if (u === "/a/deb") return res.end(deb);
    if (u === "/a/exe") return res.end(exe);
    if (u === "/a/sums") return res.end(sums);
    if (u === "/a/info") return res.end(JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", build: "0.1.0+0123456" }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => srv.close());

const hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const f = (u: string, i?: RequestInit) => fetch(u, i);

describe("update check", () => {
  it("sees a build from another commit, not its own", async () => {
    const b = await latestBuild(f, base);
    expect(b?.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(isNewer({ commit: "fedcba9" }, b)).toBe(true);
    expect(isNewer({ commit: "0123456" }, b)).toBe(false);
    expect(isNewer({ commit: null }, b)).toBe(false);
  });
  it("compares the build numbers: only a higher one is offered, a branch build ahead of the release gets nothing", () => {
    const rel = { commit: "aaaaaaa1111", build: "0.1.313+0123abcd.gaaaaaaa", publishedAt: "", notes: "", htmlUrl: "", assets: [] };
    expect(isNewer({ commit: "bbbbbbb", build: "0.1.315+4e402ca8.gbbbbbbb" }, rel)).toBe(false);
    expect(isNewer({ commit: "bbbbbbb", build: "0.1.312+4e402ca8.gbbbbbbb" }, rel)).toBe(true);
    expect(isNewer({ commit: "bbbbbbb", build: "0.1.313+4e402ca8.gbbbbbbb" }, rel)).toBe(true);
    expect(isNewer({ commit: "aaaaaaa", build: "0.1.312" }, rel)).toBe(false);
    // No number on one side (an older release or a local build): another commit is newer, as before.
    expect(isNewer({ commit: "bbbbbbb", build: "dev" }, rel)).toBe(true);
    expect(isNewer({ commit: "bbbbbbb", build: "0.1.400" }, { ...rel, build: "" })).toBe(true);
    expect(isNewer({ commit: "bbbbbbb", build: "0.1.400", version: "0.1.400" }, rel)).toBe(false);
    expect(isNewer({ commit: "bbbbbbb", build: "x", version: "0.1.2" }, rel)).toBe(true);
    expect(buildNumber("0.2.1+x")).toEqual([0, 2, 1]);
    expect(buildNumber("dev")).toBeNull();
  });
  it("no release / rate limited: nothing offered", async () => {
    releaseStatus = 403;
    expect(await latestBuild(f, base)).toBeNull();
    releaseStatus = 200;
  });
  it("picks the file for how it was installed", async () => {
    const b = (await latestBuild(f, base))!;
    expect(assetFor(installKind({ platform: "linux", execPath: "/opt/x", packaged: true }), b.assets)?.name).toMatch(/\.deb$/);
    expect(assetFor(installKind({ platform: "win32", execPath: "C:\\x.exe", packaged: true }), b.assets)?.name).toMatch(/\.exe$/);
    expect(installKind({ platform: "linux", appImage: "/home/u/d.AppImage", execPath: "/tmp/.mount/x", packaged: true })).toBe("appimage");
    expect(installKind({ platform: "linux", execPath: "/x", packaged: false })).toBe("dev");
  });
  it("downloads and checks SHA-256; a wrong sum is refused and the file deleted", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-upd-"));
    const b = (await latestBuild(f, base))!;
    const a = assetFor("deb", b.assets)!;
    sums = `${hex(deb)}  ${a.name}\n${hex(exe)}  discordrive-0.1.0-win-x64.exe\n`;
    expect(parseSums(sums).get(a.name)).toBe(hex(deb));
    const p = await downloadVerified(f, b, a, dir);
    expect(readFileSync(p).equals(deb)).toBe(true);

    const dir2 = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-upd-"));
    sums = `${"0".repeat(64)}  ${a.name}\n`;
    await expect(downloadVerified(f, b, a, dir2)).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(dir2)).toEqual([]);
    sums = "";
    await expect(downloadVerified(f, b, a, dir2)).rejects.toThrow(/no checksum/);
    expect(existsSync(join(dir2, a.name))).toBe(false);
  });
});

describe("install and restart", () => {
  it("Windows: the installer runs silently in update mode, in this copy's folder", () => {
    const c = nsisUpdateCommand("C:\\Users\\Jan Kowalski\\Downloads\\discordrive-0.1.0-win-x64.exe", "C:\\Users\\Jan Kowalski\\AppData\\Local\\Programs\\discordrive\\");
    expect(c.argv0).toBe('"C:\\Users\\Jan Kowalski\\Downloads\\discordrive-0.1.0-win-x64.exe"');
    // /D= last and unquoted (NSIS takes the rest of the line, spaces included); no trailing separator.
    expect(c.args).toEqual(["/S", "--updated", "--force-run", "/D=C:\\Users\\Jan Kowalski\\AppData\\Local\\Programs\\discordrive"]);
    expect(() => nsisUpdateCommand('C:\\a" /D=C:\\x', "C:\\b")).toThrow(/unexpected/);
    expect(() => nsisUpdateCommand("C:\\a.exe", "C:\\b\n/S")).toThrow(/unexpected/);
  });
  it("Windows, a writable AppImage and a .deb with pkexec update in place", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-upd-"));
    expect(canInstallInPlace("nsis")).toBe(true);
    expect(canInstallInPlace("deb")).toBe(false);
    expect(canInstallInPlace("dev")).toBe(false);
    expect(canInstallInPlace("appimage")).toBe(false);
    expect(canInstallInPlace("appimage", join(dir, "discordrive.AppImage"))).toBe(true);
    expect(canInstallInPlace("appimage", "/proc/discordrive.AppImage")).toBe(false);
    expect(installHint("nsis", "x", true)).toMatch(/shortcuts/);
    expect(installHint("nsis", "x", false)).toMatch(/Run the installer/);
    // .deb: in place only with pkexec (the system password dialog); dpkg -i, never apt / App Center (they refuse
    // a file with the version of the installed package).
    expect(canInstallInPlace("deb", undefined, "/usr/bin/pkexec")).toBe(true);
    expect(installHint("deb", "/d/x.deb", true)).toMatch(/password/);
    expect(installHint("deb", "/d/x.deb", false)).toBe(`in a terminal: sudo dpkg -i "/d/x.deb" — then start the app again`);
    expect(debInstallCommand("/d/x.deb", "/usr/bin/pkexec")).toEqual({ file: "/usr/bin/pkexec", args: ["dpkg", "-i", "/d/x.deb"] });
    expect(debInstallCommand("/d/x.deb", null)).toBeNull();
    expect(debTerminalCommand("/d/a b.deb")).toBe('sudo dpkg -i "/d/a b.deb"');
    // pkexec on PATH (Linux only: PATH separators and the executable bit are POSIX here).
    if (process.platform !== "win32") {
      writeFileSync(join(dir, "pkexec"), "#!/bin/sh\n");
      chmodSync(join(dir, "pkexec"), 0o755);
      expect(findPkexec(`/nonexistent:${dir}`)).toBe(join(dir, "pkexec"));
      expect(findPkexec("/nonexistent")).toBeNull();
    }
  });
  it("AppImage: the new file takes the old one's place, executable", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-upd-"));
    const target = join(dir, "discordrive.AppImage");
    const fresh = join(dir, "new.AppImage");
    writeFileSync(target, "old");
    chmodSync(target, 0o755);
    writeFileSync(fresh, "new version");
    const want = await sha256File(fresh);
    replaceAppImage(fresh, target);
    expect(readFileSync(target, "utf8")).toBe("new version");
    expect(await sha256File(target)).toBe(want);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o111).toBe(0o111);
    expect(readdirSync(dir).sort()).toEqual(["discordrive.AppImage", "new.AppImage"]);
  });
});
