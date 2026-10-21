// Update check against a fake GitHub releases API: a build from another commit is offered, the installer
// for this system is downloaded and its SHA-256 checked; a wrong checksum is refused and the file deleted.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetFor, downloadVerified, installKind, isNewer, latestBuild, parseSums, CHANNEL_TAG, REPO } from "../src/shell/updates.js";

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
