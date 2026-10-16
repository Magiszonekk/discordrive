// The real fetch transport against a local HTTP fake of Discord (no network).
import { afterEach, describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { DiscordWebhookTransport, LocalArbiter, MetadataClient, ChannelPacer, inspectForVault, memorySource, sha256Hex, type ByteSink } from "../src/index.js";
import { FakeDiscord } from "../src/node/index.js";

let fake: FakeDiscord | null = null;
afterEach(async () => void (await fake?.close()));

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (d) => void parts.push(new Uint8Array(d)),
    data: () => {
      const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) (out.set(p, o), (o += p.byteLength));
      return out;
    },
  };
}

describe("DiscordWebhookTransport against FakeDiscord", () => {
  it("upload/download round trip with real multipart, signed CDN links, inspect, edit, delete", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    const h1 = fake.addWebhook("chan-1");
    const h2 = fake.addWebhook("chan-2");
    const t = new DiscordWebhookTransport({ apiOrigin: origin });
    const w = await inspectForVault(t, h1.url);
    expect(w.channelId).toBe("chan-1");
    const c = new MetadataClient({ device: { id: "dev-f", name: "f" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [{ id: h1.id, url: h1.url }, { id: h2.id, url: h2.url }], chunkSize: 100_000 });
    const data = new Uint8Array(350_000);
    for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
    const up = await c.upload(memorySource(data), "plik.bin");
    expect(fake.posts).toBe(5);
    const s = sink();
    await c.download(up.nodeId, s);
    expect(await sha256Hex(s.data())).toBe(await sha256Hex(data));
    // channelId learned from responses, used by the pacer
    expect(c.webhooks.map((x) => x.channelId).sort()).toEqual(["chan-1", "chan-2"]);
    const posted = await t.postFile({ id: h1.id, url: h1.url }, new Uint8Array([1, 2, 3]), "a.bin");
    const edited = await t.editMessageFile({ id: h1.id, url: h1.url }, posted.messageId, new Uint8Array([4, 5]), "b.bin");
    expect(edited.attachmentId).not.toBe(posted.attachmentId);
    expect(await t.fetchCdn((await t.getAttachments({ id: h1.id, url: h1.url }, posted.messageId))[0]!.url)).toEqual(new Uint8Array([4, 5]));
    await t.deleteMessage({ id: h1.id, url: h1.url }, posted.messageId);
    await expect(t.getAttachments({ id: h1.id, url: h1.url }, posted.messageId)).rejects.toMatchObject({ status: 404 });
    await expect(inspectForVault(t, h1.url.replace(/\/[^/]+$/, "/" + "Z".repeat(68)))).rejects.toMatchObject({ status: 401 });
  });

  it("a per-channel limit is absorbed by the pacer; the upload completes", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    fake.perChannelPerMin = 6;
    const h = fake.addWebhook("chan-x");
    let virtualWait = 0;
    const pacer = new ChannelPacer({ perMin: 600, maxPerMin: 600, burst: 10, sleep: async (ms) => void ((virtualWait += ms), await new Promise((r) => setTimeout(r, Math.min(ms, 5)))) });
    const t = new DiscordWebhookTransport({ apiOrigin: origin });
    const c = new MetadataClient({ device: { id: "dev-f", name: "f" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [{ id: h.id, url: h.url }], chunkSize: 1000, pacer, sleep: async () => {} });
    // 6 posts pass, then 429 shared: pacer slows down; we let the fake's window pass by clearing it.
    const p = c.upload(memorySource(new Uint8Array(7000)), "x.bin");
    const t0 = Date.now();
    while (pacer.stats.shared429 === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    fake.perChannelPerMin = 0;
    await p;
    expect(pacer.stats.shared429).toBeGreaterThan(0);
    expect(pacer.rate("chan-x")).toBeLessThan(600);
    expect(virtualWait).toBeGreaterThan(0);
  });
});
