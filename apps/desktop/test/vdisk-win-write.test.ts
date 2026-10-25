// The disk in the system on Windows, writable: the real ddn-cf over the real AppCore (instance + fake Discord).
//   copy a file in -> a file of the account (same bytes), then a placeholder in sync;
//   overwrite it -> a new version of the same node; a folder made here -> a folder of the account, a file in it;
//   rename / move -> the same in the account; delete -> the account's trash; Office's ~$ files never uploaded.
// Skipped where the helper or the Cloud Files API is missing (Linux, macOS).
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
const run = promisify(execFile);
const until = async (f: () => boolean | Promise<boolean>, ms = 60_000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return f();
};

describe.skipIf(why !== null)(`disk in the system (Windows), writing${why ? ` — skipped: ${why}` : ""}`, () => {
  it("copy in, overwrite, folder, rename, move, delete to the trash; temp files stay local", async () => {
    process.env.DDN_CF_TRACE = "1";
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "ddn-cfw-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "cf write");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000461").url);
    const root = join(base, "discordrive");
    const disk = new VdiskWin({
      helper,
      mountpoint: root,
      socket: `\\\\.\\pipe\\ddn-cfw-test-${process.pid}`,
      cache: new FragDiskCache(join(base, "frags"), 64 << 20),
      core: core as never,
      icon: process.execPath,
      version: "0.0.1",
      outbox: join(base, "outbox"),
      log: (m) => console.log(m),
    });
    disks.push(disk);
    await disk.start();
    const rows = (parent?: string) => core.list(parent).rows;
    const names = (parent?: string) => rows(parent).map((r) => r.name).sort();
    const nodeOf = (n: string, parent?: string) => rows(parent).find((r) => r.name === n);

    // 1. A file copied in (23 MiB, 3 fragments): uploaded with the same bytes; then a placeholder in sync.
    const src = join(base, "src.bin");
    const data = new Uint8Array(randomBytes(23 * 1024 * 1024 + 99));
    await writeFile(src, data);
    await copyFile(src, join(root, "kopia ż.bin"));
    expect(await until(() => nodeOf("kopia ż.bin")?.size === data.byteLength)).toBe(true);
    await disk.outbox!.idle();
    const n1 = nodeOf("kopia ż.bin")!;
    expect(sha(new Uint8Array(await (await core.download(n1.id)).arrayBuffer()))).toBe(sha(data));
    expect(sha(await readFile(join(root, "kopia ż.bin")))).toBe(sha(data));

    // 2. Overwritten: a new version of the same node.
    await new Promise((r) => setTimeout(r, 1500));
    const data2 = new Uint8Array(randomBytes(70_001));
    await writeFile(join(root, "kopia ż.bin"), data2);
    expect(await until(() => nodeOf("kopia ż.bin")?.size === data2.byteLength)).toBe(true);
    await disk.outbox!.idle();
    expect(nodeOf("kopia ż.bin")!.id).toBe(n1.id);
    expect(sha(new Uint8Array(await (await core.download(n1.id)).arrayBuffer()))).toBe(sha(data2));

    // 3. A folder made here, a file in it.
    await mkdir(join(root, "Nowy folder"));
    expect(await until(() => nodeOf("Nowy folder")?.kind === "folder")).toBe(true);
    const fid = nodeOf("Nowy folder")!.id;
    await writeFile(join(root, "Nowy folder", "w środku.txt"), "abc");
    expect(await until(() => names(fid).includes("w środku.txt"))).toBe(true);
    await disk.outbox!.idle();

    // 4. Rename and move: the same in the account.
    await new Promise((r) => setTimeout(r, 1500));
    await rename(join(root, "kopia ż.bin"), join(root, "Nowy folder", "przeniesiony.bin"));
    expect(await until(() => names(fid).includes("przeniesiony.bin") && !names().includes("kopia ż.bin"))).toBe(true);
    expect(nodeOf("przeniesiony.bin", fid)!.id).toBe(n1.id);
    await rename(join(root, "Nowy folder"), join(root, "Folder 2"));
    expect(await until(() => names().includes("Folder 2") && !names().includes("Nowy folder"))).toBe(true);

    // 5. Office's owner file and a .tmp: never uploaded.
    await writeFile(join(root, "~$raport.docx"), "lock");
    await writeFile(join(root, "zapis.tmp"), "tmp");
    await new Promise((r) => setTimeout(r, 4000));
    await disk.outbox!.idle();
    expect(names().some((n) => n.startsWith("~$") || n.endsWith(".tmp"))).toBe(false);
    await rm(join(root, "~$raport.docx"));
    await rm(join(root, "zapis.tmp"));

    // 6. Deleted: into the account's trash (restorable), gone from the disk.
    await rm(join(root, "Folder 2", "przeniesiony.bin"));
    expect(await until(() => !names(fid).includes("przeniesiony.bin"))).toBe(true);
    expect(core.trashList().some((t) => t.id === n1.id)).toBe(true);
    expect(existsSync(join(root, "Folder 2", "przeniesiony.bin"))).toBe(false);

    // 7. The outbox empty at the end.
    expect(disk.outbox!.size).toBe(0);
    void run;
    await disk.stop();
    core.close();
  });
});
