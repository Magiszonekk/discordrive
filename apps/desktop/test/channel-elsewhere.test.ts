// A channel added on another device of the account while the agent runs: the agent reads files on it
// without a restart (the vault is re-read when a piece is on a channel it does not know), and its own
// uploads follow the channel list the other device left (a new channel is used, a retired one is not).
import { mkdtempSync } from "node:fs";
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
const cores: AppCore[] = [];
afterAll(async () => {
  for (const c of cores) c.close();
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});

describe("a channel added on another device", () => {
  it("is used here without a restart: download of a file on it, uploads go there", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-chan-elsewhere-"));

    // This device (the agent): account with one channel.
    const a = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "a") }));
    cores.push(a);
    await a.createAccount(url, "agent");
    await a.open();
    const first = fake.addWebhook("1550000000000000701");
    await a.addWebhook(first.url);

    // The other device (paired; a browser in the report).
    const b = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "b") }));
    cores.push(b);
    const offer = await b.pairStart(url, "browser");
    const accepted = a.pairAccept(offer.offer);
    let sas: { sas: string } | null = null;
    for (let i = 0; i < 100 && !sas; i++) {
      sas = await b.pairPoll();
      if (!sas) await new Promise((r) => setTimeout(r, 100));
    }
    expect(sas).not.toBeNull();
    await accepted;
    await b.pairConfirm();
    await b.open();

    // There: a new channel, the old one retired (so the file surely lands on the new one), a file.
    const second = fake.addWebhook("1550000000000000702");
    await b.addWebhook(second.url);
    const oldId = (await b.webhooks()).webhooks.find((w) => w.id !== second.id)!.id;
    await b.retireWebhook(oldId);
    const data = new Uint8Array(randomBytes(2 * 1024 * 1024 + 11));
    const up = await b.upload(new Blob([data]), "z-innego.bin");
    expect(fake.postsByChannel.get(second.channelId) ?? 0).toBeGreaterThan(0);

    // Here, still running since before the change: the file shows up and downloads.
    let row = a.list().rows.find((r) => r.id === up.nodeId);
    for (let i = 0; i < 100 && !row; i++) {
      await new Promise((r) => setTimeout(r, 100));
      row = a.list().rows.find((r) => r.id === up.nodeId);
    }
    expect(row?.name).toBe("z-innego.bin");
    const got = await a.download(up.nodeId);
    expect(await sha256Hex(new Uint8Array(await got.arrayBuffer()))).toBe(await sha256Hex(data));

    // Uploads from here follow the list: the retired channel gets nothing, the new one everything.
    const before = { old: fake.postsByChannel.get(first.channelId) ?? 0, neu: fake.postsByChannel.get(second.channelId) ?? 0 };
    await a.upload(new Blob([new Uint8Array(randomBytes(1024 * 1024))]), "stąd.bin");
    expect(fake.postsByChannel.get(first.channelId) ?? 0).toBe(before.old);
    expect(fake.postsByChannel.get(second.channelId) ?? 0).toBeGreaterThan(before.neu);
  });
});
