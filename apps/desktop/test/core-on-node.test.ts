// The browser app's core (AppCore) running in Node on the desktop platform: a real instance server, a
// fake Discord, account creation, a channel, upload and download, and a second start that finds everything
// on disk (keys, tree, journals) without asking anything.
import { mkdtempSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { sha256Hex } from "@ddv4/metadata-client";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const fake = new FakeDiscord();
const servers: DdnServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});

describe("AppCore on the desktop (Node) platform", () => {
  it("creates an account, uploads, downloads, and reopens from disk", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-desktop-core-"));

    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir }));
    await core.createAccount(url, "desktop test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000301").url);
    const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
    const up = await core.upload(new Blob([data]), "a.bin");
    const blob = await core.download(up.nodeId);
    expect(await sha256Hex(new Uint8Array(await blob.arrayBuffer()))).toBe(await sha256Hex(data));
    const listed = core.list().rows.map((r) => r.name);
    expect(listed).toContain("a.bin");
    if (process.platform !== "win32") expect(statSync(join(dataDir, "keys.bin")).mode & 0o777).toBe(0o600);
    core.close();

    // Second start of the agent: keys, tree and channel come from the data folder.
    const again = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir }));
    expect((await again.status()).hasAccount).toBe(true);
    await again.open();
    expect(again.list().rows.map((r) => r.name)).toContain("a.bin");
    const blob2 = await again.download(up.nodeId);
    expect(blob2.size).toBe(data.byteLength);
    again.close();
  });
});
