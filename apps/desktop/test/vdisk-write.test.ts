// The disk in the system, writable: the real helper over the real AppCore (instance + fake Discord).
//   cp a file in -> a file of the account (its bytes downloaded through the core = the same);
//   overwrite it -> a new version of the same node; mkdir, mv (rename and move), rm -> the account's trash;
//   a name the account does not allow -> refused (EINVAL); the outbox empty afterwards.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";
import { FragDiskCache, Vdisk } from "../src/vdisk.js";

const helper = fileURLToPath(new URL("../native/fuse/target/release/ddn-fuse", import.meta.url));
const why = Vdisk.unavailable(helper);
const run = promisify(execFile);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fake = new FakeDiscord();
const servers: DdnServer[] = [];
const disks: Vdisk[] = [];
afterAll(async () => {
  for (const d of disks) await d.stop().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});

describe.skipIf(why !== null)("disk in the system, writing", () => {
  it("cp in, overwrite, mkdir, mv, rm to the trash", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-vdiskw-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "vdisk write");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000501").url);
    const mp = join(base, "discordrive");
    const outbox = join(base, "outbox");
    const disk = new Vdisk({ helper, mountpoint: mp, socket: join(base, "run", "fuse.sock"), cache: new FragDiskCache(join(base, "frags"), 64 << 20), core: core as never, outbox, noThumbnails: true });
    disks.push(disk);
    await disk.start();
    const tree = () => core.list().rows.map((r) => r.name).sort();
    const nodeOf = (name: string, parent = "root") => core.list(parent).rows.find((r) => r.name === name);

    // 1. cp a file of 3 fragments + into the disk: a file of the account with the same bytes.
    const src = join(base, "src.bin");
    const data = new Uint8Array(randomBytes(23 * 1024 * 1024 + 99));
    writeFileSync(src, data);
    await run("cp", [src, join(mp, "kopia ż.bin")]);
    // cp ends when the copy is queued (not after Discord): the folder shows it at once, from the queue.
    expect(await readdir(mp)).toEqual(["kopia ż.bin"]);
    expect((await stat(join(mp, "kopia ż.bin"))).size).toBe(data.byteLength);
    await disk.outbox!.idle();
    const n1 = nodeOf("kopia ż.bin");
    expect(n1?.size).toBe(data.byteLength);
    expect(sha(new Uint8Array(await (await core.download(n1!.id)).arrayBuffer()))).toBe(sha(data));
    expect(sha(await readFile(join(mp, "kopia ż.bin")))).toBe(sha(data));

    // 2. Overwrite: a new version of the same node (not a second file).
    const data2 = new Uint8Array(randomBytes(70_001));
    await writeFile(join(mp, "kopia ż.bin"), data2);
    await disk.outbox!.idle();
    const n2 = nodeOf("kopia ż.bin");
    expect(n2?.id).toBe(n1!.id);
    expect(n2?.size).toBe(data2.byteLength);
    expect(sha(new Uint8Array(await (await core.download(n2!.id)).arrayBuffer()))).toBe(sha(data2));

    // 3. mkdir, mv into it with a new name, a folder rename.
    await mkdir(join(mp, "Nowy folder"));
    const f = nodeOf("Nowy folder");
    expect(f?.kind).toBe("folder");
    await rename(join(mp, "kopia ż.bin"), join(mp, "Nowy folder", "przeniesiony.bin"));
    expect(tree()).toEqual(["Nowy folder"]);
    expect(core.list(f!.id).rows.map((r) => r.name)).toEqual(["przeniesiony.bin"]);
    await rename(join(mp, "Nowy folder"), join(mp, "Folder 2"));
    expect(tree()).toEqual(["Folder 2"]);
    expect((await readdir(join(mp, "Folder 2")))).toEqual(["przeniesiony.bin"]);

    // 4. rm -> the account's trash (restorable), rmdir of a non-empty folder refused, then allowed.
    await expect(run("rmdir", [join(mp, "Folder 2")])).rejects.toThrow();
    await rm(join(mp, "Folder 2", "przeniesiony.bin"));
    expect(core.list(f!.id).rows.length).toBe(0);
    await run("rmdir", [join(mp, "Folder 2")]);
    expect(tree()).toEqual([]);

    // 5. A name that is not UTF-8: refused (EINVAL), nothing uploaded; a taken name for a folder: EEXIST.
    const { open: openRaw } = await import("node:fs/promises");
    await expect(openRaw(Buffer.concat([Buffer.from(mp + "/zła-"), Buffer.from([0xff]), Buffer.from(".txt")]), "w")).rejects.toMatchObject({ code: "EINVAL" });
    await writeFile(join(mp, "zajęte"), "x");
    await disk.outbox!.idle();
    await expect(mkdir(join(mp, "zajęte"))).rejects.toMatchObject({ code: "EEXIST" });
    await rm(join(mp, "zajęte"));
    expect(tree()).toEqual([]);
    // Removed through the disk = in the account's trash (restorable for 30 days), not purged.
    expect(core.trashList().map((t) => t.name).sort()).toEqual(["Folder 2", "zajęte"]); // the file inside its folder
    // A file removed while still queued: never in the account. Written, renamed while queued: uploaded under
    // the new name.
    await writeFile(join(mp, "szkic.txt"), "a");
    await rename(join(mp, "szkic.txt"), join(mp, "gotowe.txt"));
    await writeFile(join(mp, "tymczasowy.txt"), "b");
    await rm(join(mp, "tymczasowy.txt"));
    await disk.outbox!.idle();
    expect(tree()).toEqual(["gotowe.txt"]);
    // The outbox holds nothing after the uploads.
    expect((await readdir(outbox)).length).toBe(0);
    expect((await stat(mp)).isDirectory()).toBe(true);
    await disk.stop();
    core.close();
  });
});
