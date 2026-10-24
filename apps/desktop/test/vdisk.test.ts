// The disk in the system on Linux: the real ddn-fuse helper (native/fuse, built with cargo) mounted as the
// user over the real AppCore (desktop platform, a real instance, a fake Discord):
//   - the tree is listed with no request to Discord; sizes and dates are the index's;
//   - ranges read with dd and whole files read with sha256 match the account's bytes;
//   - the fragment cache stays under its limit while a file bigger than the limit is read;
//   - a killed helper leaves a stale mount: the next start cleans it and mounts again.
// Skipped where FUSE or the helper is missing (macOS, Windows, a runner without /dev/fuse).
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";
import { FragDiskCache, Vdisk } from "../src/vdisk.js";

const helper = fileURLToPath(new URL("../native/fuse/target/release/ddn-fuse", import.meta.url));
const why = Vdisk.unavailable(helper);
const fake = new FakeDiscord();
const servers: DdnServer[] = [];
const disks: Vdisk[] = [];
afterAll(async () => {
  for (const d of disks) await d.stop().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// Never a synchronous call on the mount: the agent answering the helper runs on this same event loop.
const run = promisify(execFile);
const exists = (p: string) => stat(p).then(() => true, () => false);

describe.skipIf(why !== null)(`disk in the system (FUSE)${why ? ` — skipped: ${why}` : ""}`, () => {
  it("lists without Discord, reads ranges and whole files, keeps the cache under its limit, survives a killed helper", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-vdisk-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "vdisk test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000401").url);
    // A folder with two files: one of several fragments (bigger than the cache limit below), one small.
    const f = { nodeId: await core.mkdir("Zdjęcia Ż") };
    const big = new Uint8Array(randomBytes(25 * 1024 * 1024 + 123));
    const small = new Uint8Array(randomBytes(70_001));
    await core.upload(new Blob([big]), "film duży.bin", f.nodeId);
    await core.upload(new Blob([small]), "notatka.txt", f.nodeId);

    const mp = join(base, "discordrive");
    const cache = new FragDiskCache(join(base, "frags"), 15 * 1024 * 1024);
    const disk = new Vdisk({ helper, mountpoint: mp, socket: join(base, "run", "fuse.sock"), cache, core: core as never });
    disks.push(disk);
    await disk.start();
    expect(disk.mounted()).toBe(true);

    // 1. The tree: no request to Discord while listing.
    const before = fake.cdnGets;
    expect(await readdir(mp)).toEqual(["Zdjęcia Ż"]);
    const dir = join(mp, "Zdjęcia Ż");
    expect((await readdir(dir)).sort()).toEqual(["film duży.bin", "notatka.txt"]);
    expect((await stat(join(dir, "film duży.bin"))).size).toBe(big.byteLength);
    expect((await stat(join(dir, "notatka.txt"))).isFile()).toBe(true);
    expect((await stat(dir)).isDirectory()).toBe(true);
    // ls -lR in another process, as a file manager does.
    expect((await run("ls", ["-lR", mp])).stdout).toContain("notatka.txt");
    const listedWithoutDiscord = fake.cdnGets === before;

    // 2. Ranges (dd) and whole files.
    const off = 12 * 1024 * 1024 + 7;
    const part = (await run("dd", [`if=${join(dir, "film duży.bin")}`, "iflag=skip_bytes,count_bytes", `skip=${off}`, "count=4096", "status=none"], { encoding: "buffer" })).stdout;
    expect(sha(part)).toBe(sha(big.subarray(off, off + 4096)));
    expect(sha(await readFile(join(dir, "notatka.txt")))).toBe(sha(small));
    const t0 = Date.now();
    expect((await run("sha256sum", [join(dir, "film duży.bin")])).stdout.split(" ")[0]).toBe(sha(big));
    const ms = Date.now() - t0;
    // 3. The cache limit (15 MiB) held while reading 25 MiB.
    expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
    expect(cache.bytes).toBeGreaterThan(0);
    // Read-only in this version.
    await expect(run("sh", ["-c", `echo x > '${join(dir, "nowy.txt")}'`])).rejects.toThrow();

    // 4. A killed helper: the mount is stale ("not connected"); start() cleans it and mounts again.
    spawnSync("pkill", ["-9", "-f", `ddn-fuse ${mp}`]);
    await new Promise((r) => setTimeout(r, 300));
    await expect(readdir(mp)).rejects.toThrow();
    await disk.stop();
    await disk.start();
    expect((await readdir(join(mp, "Zdjęcia Ż"))).length).toBe(2);
    await disk.stop();
    expect(disk.mounted()).toBe(false);
    expect(await exists(join(mp, "Zdjęcia Ż"))).toBe(false);
    core.close();
    console.log(JSON.stringify({ vdisk: { listedWithoutDiscord, readMBps: Math.round((big.byteLength / 1e6 / (ms / 1000)) * 10) / 10, cacheBytes: cache.bytes, cacheLimit: cache.limit } }));
    expect(listedWithoutDiscord).toBe(true);
  });
});
