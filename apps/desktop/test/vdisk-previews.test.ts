// Files written into the disk get the account's thumbnail and preview (made on this computer from the local
// copy, as the web client does at upload): a JPEG turned by its EXIF, a PNG, an MP4 (frame by ffmpeg); a text
// file none. The file manager then gets a thumbnail, not a "none" marker.
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";
import { FragDiskCache, Vdisk } from "../src/vdisk.js";
import { fileUri } from "../src/vdisk-thumbs.js";

const helper = fileURLToPath(new URL("../native/fuse/target/release/ddn-fuse", import.meta.url));
const why = Vdisk.unavailable(helper);
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"]).error;
const run = promisify(execFile);
const fake = new FakeDiscord();
const servers: DdnServer[] = [];
const disks: Vdisk[] = [];
afterAll(async () => {
  for (const d of disks) await d.stop().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});

describe.skipIf(why !== null || !hasFfmpeg)("disk in the system, previews of written files", () => {
  it("JPEG (EXIF-rotated), PNG, MP4 get a thumbnail and a preview; text none", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-vdiskp-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "vdisk previews");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000701").url);
    const mp = join(base, "discordrive");
    const thumbDir = join(base, "thumbnails");
    const disk = new Vdisk({ helper, mountpoint: mp, socket: join(base, "run", "fuse.sock"), cache: new FragDiskCache(join(base, "frags"), 64 << 20), core: core as never, outbox: join(base, "outbox"), thumbnailDir: thumbDir });
    disks.push(disk);
    await disk.start();
    // Sources: a 1200x800 JPEG marked "rotate 90" in EXIF (shown 800x1200), a PNG, a 4 s MP4.
    const src = join(base, "src");
    await run("mkdir", ["-p", src]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1200x800", "-frames:v", "1", join(src, "a.jpg")]);
    const jpg = await readFile(join(src, "a.jpg"));
    // APP1 Exif with Orientation = 6 (rotate 90 CW), right after SOI.
    const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), Buffer.from("Exif\0\0", "latin1"), tiff]);
    app1.writeUInt16BE(app1.length - 2, 2);
    await writeFile(join(src, "obrót.jpg"), Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", join(src, "b.png")]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "4", "-pix_fmt", "yuv420p", join(src, "film.mp4")]);
    await writeFile(join(src, "tekst.txt"), "abc");
    for (const n of ["obrót.jpg", "b.png", "film.mp4", "tekst.txt"]) await copyFile(join(src, n), join(mp, n));
    await disk.outbox!.idle();

    const row = (n: string) => core.list().rows.find((r) => r.name === n)!;
    const pic = async (n: string, kind: "t" | "p") => (core as unknown as { vdiskPreview(id: string, k: "t" | "p"): Promise<{ data: Uint8Array; mime: string } | null> }).vdiskPreview(row(n).id, kind);
    const dims = async (d: Uint8Array) => {
      const f = join(base, `x-${createHash("md5").update(d).digest("hex")}.jpg`);
      await writeFile(f, d);
      return (await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", f])).stdout.trim();
    };
    // Turned by EXIF: portrait; the thumbnail's shorter side 320, the preview's longer 1200 (never enlarged).
    expect(await dims((await pic("obrót.jpg", "t"))!.data)).toBe("320,480");
    expect(await dims((await pic("obrót.jpg", "p"))!.data)).toBe("800,1200");
    expect(await dims((await pic("b.png", "t"))!.data)).toBe("427,320");
    expect(await dims((await pic("film.mp4", "t"))!.data)).toBe("569,320");
    expect((await pic("film.mp4", "p"))?.mime).toBe("image/jpeg");
    expect(await pic("tekst.txt", "t")).toBeNull();
    // The file manager's thumbnails: written for the pictures and the video, a "none" marker only for text.
    const md5 = (p: string) => createHash("md5").update(fileUri(join(mp, p))).digest("hex") + ".png";
    for (let i = 0; i < 50 && !existsSync(join(thumbDir, "normal", md5("film.mp4"))); i++) await new Promise((r) => setTimeout(r, 100));
    for (const n of ["obrót.jpg", "b.png", "film.mp4"]) {
      expect(existsSync(join(thumbDir, "normal", md5(n)))).toBe(true);
      expect(existsSync(join(thumbDir, "fail", "discordrive", md5(n)))).toBe(false);
    }
    await disk.stop();
    core.close();
  });
});
