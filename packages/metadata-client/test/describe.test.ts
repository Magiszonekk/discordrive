import { describe, expect, it } from "vitest";
import { createHmac, hkdfSync, createCipheriv, randomBytes } from "node:crypto";
import { ROOT_ID } from "@ddv4/sync-core";
import { descriptionName, foldText, openDescription, sealDescription, searchItems, type DescriptionRecord } from "../src/describe.js";
import { ChannelPacer, EncryptedArbiter, InProcessLogServer, MemoryTransport, MemoryVaultStore, MetadataClient, OpCodec, WebhookVault, decodeManifestRef, memorySource, newAccountKey, type WebhookTransport } from "../src/index.js";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";


const fk = randomBytes(32);
const k = fk.toString("base64");
const rec: DescriptionRecord = { description: "Paragon ze sklepu", tags: ["paragon", "zakupy"], text: "RAZEM 42,50 PLN", model: "m", at: 1, lang: "pl" };
const hk = (info: string) => Buffer.from(hkdfSync("sha256", fk, Buffer.alloc(0), info, 32));

describe("AI descriptions (the phone's format)", () => {
  it("seal / open round trip, wrong key refused", async () => {
    const sealed = await sealDescription(k, rec);
    expect(await openDescription(k, sealed)).toEqual(rec);
    await expect(openDescription(randomBytes(32).toString("base64"), sealed)).rejects.toThrow();
  });

  it("the name and the cipher match an independent implementation (node:crypto, as the phone)", async () => {
    const name = createHmac("sha256", hk("ddv4-file-preview-name-v1")).update("ddn-description:1").digest("base64url").slice(0, 22);
    expect(await descriptionName(k)).toBe(name);
    // Sealed as the phone does (AES-GCM, iv | ct | tag, AAD "ddn-description-v1").
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", hk("ddv4-file-description-v1"), iv);
    c.setAAD(Buffer.from("ddn-description-v1"));
    const body = Buffer.concat([c.update(JSON.stringify({ v: 1, description: "Kot", tags: ["kot"], model: "x", at: 5, lang: "pl" })), c.final(), c.getAuthTag()]);
    expect((await openDescription(k, new Uint8Array(Buffer.concat([iv, body])))).tags).toEqual(["kot"]);
  });

  it("search: fields, diacritics, dates, every word, order", () => {
    const at = (d: string) => Date.parse(d + "T12:00:00Z");
    const items = [
      { id: "1", name: "IMG_0001.jpg", date: at("2024-05-17"), record: rec },
      { id: "2", name: "kot.jpg", date: at("2023-01-02"), record: { ...rec, description: "Żółty kot", tags: ["kot"], text: undefined } },
      { id: "3", name: "wakacje paragon.pdf", date: at("2024-07-01"), record: null },
    ];
    const ids = (q: string) => searchItems(items, q, 0).map((x) => x.id);
    expect(ids("paragon")).toEqual(["3", "1"]);
    expect(ids("42,50")).toEqual(["1"]);
    expect(ids("zolty KOT")).toEqual(["2"]);
    expect(ids("2024-05")).toEqual(["1"]);
    expect(ids("2024")).toEqual(["3", "1"]);
    expect(ids("paragon 2024-05")).toEqual(["1"]);
    expect(ids("kot 2024")).toEqual([]);
    expect(foldText("Łódź Żółć")).toBe("lodz zolc");
  });
});

const ACCT = "acct-desc";
const H = [
  { id: "111111111111111111", url: "mem://hook/1", channelId: "c111", guildId: null, label: "#1", addedAt: 1 },
  { id: "222222222222222222", url: "mem://hook/2", channelId: "c222", guildId: null, label: "#2", addedAt: 2 },
];
const rnd = (n: number) => {
  const b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
  return b;
};


async function world() {
  const key = newAccountKey();
  const transport = new MemoryTransport();
  const server = new InProcessLogServer({ now: () => Date.now() });
  const vault = new WebhookVault(new MemoryVaultStore(), key, ACCT);
  for (const h of H) await vault.addWebhook(h);
  const arb = (dev: string) => new EncryptedArbiter(new OpCodec(key, ACCT), server.session(dev));
  const store = new SqliteIndexStore();
  const mk = async (dev: string, t: WebhookTransport = transport, st = new SqliteIndexStore()) =>
    new MetadataClient({
      device: { id: dev, name: dev },
      arbiter: arb(dev),
      transport: t,
      webhooks: (await vault.load()).webhooks.map((w) => ({ id: w.id, url: w.url, channelId: w.channelId, ...(w.retired ? { retired: true } : {}) })),
      store: st,
      chunkSize: 500,
      sleep: async () => {},
      pacer: new ChannelPacer({ perMin: 600_000, maxPerMin: 600_000, burst: 10_000 }),
    });
  return { key, transport, server, vault, store, arb, mk };
}


describe("descriptions stored with a file, read by another device", () => {
  it("a description added next to the manifest (as the phone does) is read by device B; takenAt from the manifest", async () => {
    const w = await world();
    const a = await w.mk("dev-A");
    const taken = Date.UTC(2024, 4, 17, 10);
    const r = await a.upload(memorySource(crypto.getRandomValues(new Uint8Array(900))), "IMG_1.jpg", ROOT_ID, { takenAt: taken });
    const loc = decodeManifestRef(r.version.manifestRef);
    // The phone edits the manifest's message: the same as addExtras with the description's name.
    const name = await descriptionName(loc.k);
    const hook = w.transport as unknown as { addFiles: (h: unknown, m: string, keep: string[], x: { filename: string; data: Uint8Array }[]) => Promise<unknown> };
    const mid = (loc.at as { messageId: string }).messageId;
    const keep = w.transport.messages.get(mid)!.attachments.map((x) => x.id);
    await hook.addFiles({ id: (loc.at as { locationId: string }).locationId, url: "mem://hook/1" }, mid, keep, [{ filename: name + ".txt", data: await sealDescription(loc.k, rec) }]);
    const b = await w.mk("dev-B");
    await b.pull();
    expect(await b.readDescription(r.version.manifestRef)).toEqual(rec);
    expect(await b.takenAt(r.version.manifestRef)).toBe(taken);
    // A file without either.
    const r2 = await a.upload(memorySource(crypto.getRandomValues(new Uint8Array(300))), "plain.bin", ROOT_ID);
    expect(await b.readDescription(r2.version.manifestRef)).toBeNull();
    expect(await b.takenAt(r2.version.manifestRef)).toBeNull();
  });
});
