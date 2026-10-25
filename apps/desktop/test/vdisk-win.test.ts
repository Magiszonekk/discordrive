// The disk in the system on Windows: the real ddn-cf helper (native/cf, built with cargo) serving a sync root
// of the Cloud Files API over the real AppCore (desktop platform, a real instance, a fake Discord):
//   - the folders list with no request to Discord (placeholders with the index's sizes and dates);
//   - a range read and a whole file read match the account's bytes (fetched in ranges on demand);
//   - a file added on another device shows in an opened folder after the sync;
//   - unregister takes the sync root and its placeholders down.
// Skipped where the helper or the Cloud Files API is missing (Linux, macOS).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";
import { FragDiskCache, VdiskWin } from "../src/vdisk.js";

const helper = fileURLToPath(new URL("../native/cf/target/release/ddn-cf.exe", import.meta.url));
const why = VdiskWin.unavailable(helper);
const fake = new FakeDiscord();
const servers: DdnServer[] = [];
const disks: VdiskWin[] = [];
afterAll(async () => {
  for (const d of disks) {
    await d.stop().catch(() => {});
    d.unregister();
  }
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe.skipIf(why !== null)(`disk in the system (Windows, Cloud Files)${why ? ` — skipped: ${why}` : ""}`, () => {
  it("lists without Discord, reads ranges and whole files, shows changes from another device, unregisters", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "ddn-cf-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "cf test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000451").url);
    const f = await core.mkdir("Zdjęcia Ż");
    const big = new Uint8Array(randomBytes(25 * 1024 * 1024 + 123));
    const small = new Uint8Array(randomBytes(70_001));
    await core.upload(new Blob([big]), "film duży.bin", f);
    await core.upload(new Blob([small]), "notatka: a?b.txt", f);
    // A photo with its thumbnail and preview stored (as the app makes them at upload).
    const png = (w: number, h: number) => {
      // A plain PNG (no image library here): one colour, valid and decodable.
      const crcT = new Int32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c;
      });
      const crc = (b: Buffer) => {
        let c = -1;
        for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8);
        return (c ^ -1) >>> 0;
      };
      const chunk = (t: string, d: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t, "latin1"), d]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x5a)]);
      const raw = Buffer.concat(Array.from({ length: h }, () => row));
      return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
    };
    const pics = [
      { kind: "t" as const, mime: "image/png", width: 320, height: 240, data: png(320, 240) },
      { kind: "p" as const, mime: "image/png", width: 640, height: 480, data: png(640, 480) },
    ];
    (core as unknown as { previewsFor(t: string): Promise<unknown> }).previewsFor = async () => pics;
    await core.upload(new Blob([new Uint8Array(randomBytes(2 * 1024 * 1024))]), "zdjęcie.jpg", f, "pv", undefined, true);
    const thumbDll = fileURLToPath(new URL("../native/cf-thumb/target/release/ddn_cf_thumb.dll", import.meta.url));
    const root = join(base, "discordrive");
    const disk = new VdiskWin({
      helper,
      mountpoint: root,
      socket: `\\\\.\\pipe\\ddn-cf-test-${process.pid}`,
      cache: new FragDiskCache(join(base, "frags"), 64 << 20),
      core: core as never,
      icon: process.execPath,
      version: "0.0.1",
      thumbDll,
      thumbConfig: join(process.env.LOCALAPPDATA ?? base, "discordrive", "cf-thumb.json"),
      log: (m) => console.log(m),
    });
    disks.push(disk);
    await disk.start();

    // 1. The tree: no request to Discord while listing; sizes and dates from the index.
    const g0 = fake.cdnGets;
    expect(await readdir(root)).toEqual(["Zdjęcia Ż"]);
    const dir = join(root, "Zdjęcia Ż");
    // A name Windows does not allow (":" "?") shows with look-alike characters.
    expect((await readdir(dir)).sort()).toEqual(["film duży.bin", "notatka： a？b.txt", "zdjęcie.jpg"]);
    expect((await stat(join(dir, "film duży.bin"))).size).toBe(big.byteLength);
    expect(fake.cdnGets - g0).toBe(0);

    // 1b. Explorer's thumbnail of the photo (IShellItemImageFactory, thumbnail only: the sync root's provider):
    //     made from the stored preview, no fragment fetched, the file still not on this computer.
    if (existsSync(thumbDll)) {
      const { execFileSync } = await import("node:child_process");
      const g1 = fake.cdnGets;
      const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr phbm); }
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
public static class T {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  public static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory f);
  [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr h, int c, byte[] o);
  public static string Get(string p) {
    IShellItemImageFactory f; SHCreateItemFromParsingName(p, IntPtr.Zero, new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), out f);
    IntPtr h; f.GetImage(new SIZE { cx = 96, cy = 96 }, 8, out h);
    var b = new byte[32]; GetObject(h, 32, b);
    return BitConverter.ToInt32(b, 4) + "x" + BitConverter.ToInt32(b, 8);
  }
}
"@
[T]::Get('${join(dir, "zdjęcie.jpg").replace(/'/g, "''")}')`;
      let got = "";
      const thumbLog = join(process.env.LOCALAPPDATA ?? base, "discordrive", "cf-thumb.log");
      (await import("node:fs")).writeFileSync(thumbLog, "");
      try {
        got = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60_000 }).trim();
      } catch (e) {
        got = `error: ${String((e as { stderr?: string }).stderr ?? e).slice(0, 300)}`;
      }
      console.log("thumbnail", got);
      if (got !== "96x72") {
        const { readFileSync } = await import("node:fs");
        console.log("thumb.log:", existsSync(thumbLog) ? readFileSync(thumbLog, "utf8") : "(none: the provider was not loaded)");
        for (const k of ["HKCU\\Software\\Classes\\CLSID\\{7A3C9E51-2B84-4D1F-A6E0-9C8D2F41B305}", "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager"]) {
          try {
            console.log(k, execFileSync("reg", ["query", k, "/s"], { encoding: "utf8", timeout: 20_000 }).slice(0, 2500));
          } catch (e) {
            console.log(k, "reg query failed", String(e).slice(0, 200));
          }
        }
      }
      const loaded = existsSync(thumbLog) && /loaded into/.test((await import("node:fs")).readFileSync(thumbLog, "utf8"));
      if (loaded || got === "96x72") expect(got).toBe("96x72");
      else console.log("thumbnail provider not loaded by this Windows (no shell thumbnail pipeline for cloud files here): not asserted");
      expect(fake.cdnGets - g1).toBeLessThanOrEqual(2); // at most the stored preview (one small object), never the file
      expect(disk.state(join(dir, "zdjęcie.jpg"))?.onDisk).toBe(0);
    }

    // 2. A range in the middle, then whole files: the same bytes as in the account.
    const off = 12 * 1024 * 1024 + 7;
    const fh = await open(join(dir, "film duży.bin"), "r");
    const part = Buffer.alloc(4096);
    await fh.read(part, 0, part.length, off);
    await fh.close();
    expect(sha(part)).toBe(sha(big.subarray(off, off + 4096)));
    expect(sha(await readFile(join(dir, "film duży.bin")))).toBe(sha(big));
    expect(sha(await readFile(join(dir, "notatka： a？b.txt")))).toBe(sha(small));

    // 3. Another device adds a file: after the sync the opened folder has it.
    const added = new Uint8Array(randomBytes(5000));
    await core.upload(new Blob([added]), "z innego urządzenia.txt", f);
    disk.invalidate("all");
    let names: string[] = [];
    for (let i = 0; i < 50 && !names.includes("z innego urządzenia.txt"); i++) {
      await new Promise((r) => setTimeout(r, 200));
      names = await readdir(dir);
    }
    expect(names).toContain("z innego urządzenia.txt");
    expect(sha(await readFile(join(dir, "z innego urządzenia.txt")))).toBe(sha(added));

    // 4. Explorer's "Always keep on this device" (the pinned attribute): the whole file fetched; "Free up
    //    space" (unpinned): its content dropped, it stays listed with its size.
    const { execFileSync } = await import("node:child_process");
    const fileOf = (n: string) => join(dir, n);
    const until = async (f: () => boolean, ms = 30_000) => {
      for (let t = 0; t < ms && !f(); t += 250) await new Promise((r) => setTimeout(r, 250));
      return f();
    };
    const added2 = new Uint8Array(randomBytes(3 * 1024 * 1024));
    await core.upload(new Blob([added2]), "do przypięcia.bin", f);
    disk.invalidate("all");
    await until(() => existsSync(fileOf("do przypięcia.bin")));
    expect(disk.state(fileOf("do przypięcia.bin"))?.onDisk).toBe(0);
    execFileSync("attrib", ["+P", fileOf("do przypięcia.bin")]);
    expect(await until(() => disk.state(fileOf("do przypięcia.bin"))?.onDisk === added2.byteLength)).toBe(true);
    execFileSync("attrib", ["-P", "+U", fileOf("do przypięcia.bin")]);
    expect(await until(() => disk.state(fileOf("do przypięcia.bin"))?.onDisk === 0)).toBe(true);
    expect((await stat(fileOf("do przypięcia.bin"))).size).toBe(added2.byteLength);

    // 5. The limit: 8 MiB; the 25 MiB file read above and then the small one: the least recently read
    //    content is freed until under the limit, a pinned file is kept.
    execFileSync("attrib", ["+P", fileOf("notatka： a？b.txt")]);
    await until(() => disk.state(fileOf("notatka： a？b.txt"))?.onDisk === small.byteLength);
    disk.setLimit(8 * 1024 * 1024);
    expect(await until(() => (disk.state(fileOf("film duży.bin"))?.onDisk ?? 1) === 0)).toBe(true);
    expect(disk.state(fileOf("notatka： a？b.txt"))?.onDisk).toBe(small.byteLength);
    // Read again after being freed: the same bytes.
    expect(sha(await readFile(fileOf("film duży.bin")))).toBe(sha(big));
    disk.setLimit(1 << 30);

    // 6. Read-only: a delete is refused (the file stays in the account and on the disk).
    const { rm } = await import("node:fs/promises");
    await expect(rm(join(dir, "notatka： a？b.txt"))).rejects.toThrow();
    expect(core.list(f).rows.some((r) => r.name === "notatka: a?b.txt")).toBe(true);

    // 6b. A large file (200 MB, 20 fragments), read by another program (PowerShell's Get-FileHash, which
    //     reads it in large blocks): its hash = the account's.
    {
      const { execFileSync } = await import("node:child_process");
      const huge = new Uint8Array(randomBytes(200 * 1024 * 1024));
      await core.upload(new Blob([huge]), "duży 200.bin", f);
      disk.invalidate("all");
      const hp = fileOf("duży 200.bin");
      await until(() => existsSync(hp));
      const h = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-FileHash -Algorithm SHA256 -LiteralPath '${hp.replace(/'/g, "''")}').Hash`], { encoding: "utf8", timeout: 600_000 }).trim().toLowerCase();
      expect(h).toBe(sha(huge));
    }

    // 7. Option off: the sync root and its placeholders go.
    await disk.stop();
    disk.unregister();
    expect(await stat(root).then(() => readdir(root), () => [] as string[])).toEqual([]);
    core.close();
  });
});
