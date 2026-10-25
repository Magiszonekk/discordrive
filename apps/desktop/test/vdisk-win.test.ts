// The disk in the system on Windows: the real ddn-cf helper (native/cf, built with cargo) serving a sync root
// of the Cloud Files API over the real AppCore (desktop platform, a real instance, a fake Discord):
//   - the folders list with no request to Discord (placeholders with the index's sizes and dates);
//   - a range read and a whole file read match the account's bytes (fetched in ranges on demand);
//   - a file added on another device shows in an opened folder after the sync;
//   - unregister takes the sync root and its placeholders down.
// Skipped where the helper or the Cloud Files API is missing (Linux, macOS).
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    const root = join(base, "discordrive");
    const disk = new VdiskWin({
      helper,
      mountpoint: root,
      socket: `\\\\.\\pipe\\ddn-cf-test-${process.pid}`,
      cache: new FragDiskCache(join(base, "frags"), 64 << 20),
      core: core as never,
      icon: process.execPath,
      version: "0.0.1",
      log: (m) => console.log(m),
    });
    disks.push(disk);
    await disk.start();

    // 1. The tree: no request to Discord while listing; sizes and dates from the index.
    const g0 = fake.cdnGets;
    expect(await readdir(root)).toEqual(["Zdjęcia Ż"]);
    const dir = join(root, "Zdjęcia Ż");
    // A name Windows does not allow (":" "?") shows with look-alike characters.
    expect((await readdir(dir)).sort()).toEqual(["film duży.bin", "notatka： a？b.txt"]);
    expect((await stat(join(dir, "film duży.bin"))).size).toBe(big.byteLength);
    expect(fake.cdnGets - g0).toBe(0);

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

    // 4. Read-only: a delete is refused (the file stays in the account and on the disk).
    const { rm } = await import("node:fs/promises");
    await expect(rm(join(dir, "notatka： a？b.txt"))).rejects.toThrow();
    expect(core.list(f).rows.some((r) => r.name === "notatka: a?b.txt")).toBe(true);

    // 5. Option off: the sync root and its placeholders go.
    await disk.stop();
    disk.unregister();
    expect(await stat(root).then(() => readdir(root), () => [] as string[])).toEqual([]);
    core.close();
  });
});
