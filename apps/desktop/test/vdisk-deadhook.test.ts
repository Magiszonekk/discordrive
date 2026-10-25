// A channel of the account removed on Discord (its webhook answers 404) next to a working one: a large file
// copied into the disk is uploaded at the first try (the removed channel is left out after its first 404,
// the fragment goes to the other), not started over and over.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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

describe.skipIf(why !== null)("disk in the system, a removed channel in the pool", () => {
  it("50 MB through the disk with one webhook answering 404: uploaded at the first try", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-vdiskd-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "dead hook");
    await core.open();
    const dead = fake.addWebhook("1550000000000000901");
    await core.addWebhook(dead.url);
    await core.addWebhook(fake.addWebhook("1550000000000000902").url);
    fake.deleteWebhook(dead.id);
    const posts0 = fake.posts;
    const req0 = fake.webhookRequests;
    const log: string[] = [];
    const disk = new Vdisk({ helper, mountpoint: join(base, "discordrive"), socket: join(base, "run", "fuse.sock"), cache: new FragDiskCache(join(base, "frags"), 64 << 20), core: core as never, outbox: join(base, "outbox"), noThumbnails: true, log: (m) => log.push(m) });
    disks.push(disk);
    await disk.start();
    const data = new Uint8Array(randomBytes(50 * 1024 * 1024 + 7));
    const src = join(base, "big.bin");
    writeFileSync(src, data);
    await run("cp", [src, join(base, "discordrive", "duży.bin")]);
    await disk.outbox!.idle();
    expect(log.filter((m) => /failed/.test(m))).toEqual([]);
    // The removed channel was left out after its first answer (webhook requests that stored nothing = its
    // 401s): at most the posts already in flight then (before: every fragment's tries on it).
    const deadHits = fake.webhookRequests - req0 - (fake.posts - posts0);
    expect(deadHits).toBeLessThanOrEqual(3);
    const row = core.list().rows.find((r) => r.name === "duży.bin");
    expect(row?.size).toBe(data.byteLength);
    expect(sha(new Uint8Array(await (await core.download(row!.id)).arrayBuffer()))).toBe(sha(data));
    await disk.stop();
    core.close();
  });
});
