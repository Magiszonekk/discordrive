// Encrypted thumbnails / previews next to the manifest: format (sealed with the file key, names derived
// from it, kind checked), compatibility (an older client reads a file with previews byte for byte; a newer
// one reads files without them), adding previews to an existing file later, a failed preview never fails
// the upload, and they go away with the manifest's message (cleanup) and move with it (channel move).
import { describe, expect, it } from "vitest";
import { ROOT_ID } from "@ddv4/sync-core";
import {
  ChannelMover,
  ChannelPacer,
  EncryptedArbiter,
  InProcessLogServer,
  MemoryTransport,
  MemoryVaultStore,
  MetadataClient,
  OpCodec,
  PREVIEW_LIMITS,
  WebhookVault,
  checkImage,
  decodeManifestRef,
  memorySource,
  newAccountKey,
  newFileKey,
  openPreview,
  previewKeys,
  sealPreview,
  type ByteSink,
  type PreviewImage,
  type WebhookTransport,
} from "../src/index.js";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";

const ACCT = "acct-prev";
const H = [
  { id: "111111111111111111", url: "mem://hook/1", channelId: "c111", guildId: null, label: "#1", addedAt: 1 },
  { id: "222222222222222222", url: "mem://hook/2", channelId: "c222", guildId: null, label: "#2", addedAt: 2 },
];
const rnd = (n: number) => {
  const b = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
  return b;
};
const img = (kind: "t" | "p", n = 2000, w = kind === "t" ? 320 : 1280, h = 213): PreviewImage => ({ kind, mime: "image/webp", width: w, height: h, data: rnd(n) });
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => Buffer.concat(parts) };
}

/** A transport as an older client has it: no multi-file posts or edits, attachments without names. */
function oldTransport(t: MemoryTransport): WebhookTransport {
  return {
    postFile: t.postFile.bind(t),
    getAttachments: async (h, m) => (await t.getAttachments(h, m)).map(({ id, url, size }) => ({ id, url, size })),
    fetchCdn: t.fetchCdn.bind(t),
    inspectWebhook: t.inspectWebhook.bind(t),
    editMessageFile: t.editMessageFile.bind(t),
    deleteMessage: t.deleteMessage.bind(t),
  };
}

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

describe("preview format", () => {
  it("sealed with the file key: round trip, names from the key, the kind is checked, other keys fail", async () => {
    const fk = await newFileKey();
    const keys = await previewKeys(fk.rawB64);
    expect(keys.names.t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keys.names.t).not.toBe(keys.names.p);
    // The same file key gives the same names on any device.
    expect((await previewKeys(fk.rawB64)).names).toEqual(keys.names);
    const t = img("t", 3000);
    const b = await sealPreview(keys, t);
    expect(b.name).toBe(keys.names.t);
    expect(b.data.byteLength).toBeGreaterThan(3000);
    // No plaintext visible: the image bytes do not appear in the sealed blob.
    expect(Buffer.from(b.data).includes(Buffer.from(t.data.subarray(0, 64)))).toBe(false);
    const back = await openPreview(keys, "t", b.data);
    expect(back).toMatchObject({ kind: "t", mime: "image/webp", width: 320, height: 213 });
    expect(Buffer.from(back.data).equals(Buffer.from(t.data))).toBe(true);
    await expect(openPreview(keys, "p", b.data)).rejects.toThrow(/other kind/);
    const other = await previewKeys((await newFileKey()).rawB64);
    expect(other.names.t).not.toBe(keys.names.t);
    await expect(openPreview(other, "t", b.data)).rejects.toThrow();
    const bad = new Uint8Array(b.data);
    bad[40] = bad[40]! ^ 1;
    await expect(openPreview(keys, "t", bad)).rejects.toThrow();
  });

  it("limits: type, bytes and size are checked before storing", () => {
    expect(checkImage(img("t"))).toBeNull();
    expect(checkImage({ ...img("t"), mime: "image/svg+xml" })).toBe("bad type");
    expect(checkImage(img("t", PREVIEW_LIMITS.t.maxBytes + 1))).toBe("too big");
    expect(checkImage(img("p", PREVIEW_LIMITS.p.maxBytes + 1))).toBe("too big");
    expect(checkImage(img("t", 100, 641, 320))).toBe("bad size");
    expect(checkImage(img("p", 100, 1281, 720))).toBe("bad size");
    expect(checkImage({ ...img("t"), data: new Uint8Array(0) })).toBe("empty");
  });
});

describe("previews next to the manifest (metadata only)", () => {
  it("upload with previews: one message for the manifest and both pictures; read back; same posts as without", async () => {
    const w = await world();
    const a = await w.mk("dev-A");
    const data = crypto.getRandomValues(new Uint8Array(1200)); // 3 fragments + manifest
    const posts0 = w.transport.posts;
    const r = await a.upload(memorySource(data), "foto.jpg", ROOT_ID, { previews: Promise.resolve([img("t", 1500), img("p", 9000)]) });
    // 3 fragments + 1 manifest message: the previews added no message.
    expect(w.transport.posts - posts0).toBe(4);
    const loc = decodeManifestRef(r.version.manifestRef);
    const msg = w.transport.messages.get((loc.at as { messageId: string }).messageId)!;
    expect(msg.attachments.length).toBe(3);
    const keys = await previewKeys(loc.k);
    expect(msg.attachments.map((x) => x.filename).sort()).toEqual([...msg.attachments.map((x) => x.filename)].sort());
    expect(msg.attachments.some((x) => x.filename === `${keys.names.t}.txt`)).toBe(true);
    // Another device (no shared cache) reads them.
    const b = await w.mk("dev-B");
    await b.pull();
    const t = await b.readPreview(r.version.manifestRef, "t");
    const p = await b.readPreview(r.version.manifestRef, "p");
    expect(t?.data.byteLength).toBe(1500);
    expect(p?.data.byteLength).toBe(9000);
    // The file itself is untouched.
    const s = sink();
    await b.download(r.nodeId, s);
    expect(Buffer.from(s.data()).equals(Buffer.from(data))).toBe(true);
  });

  it("compatibility: an older client downloads a file with previews; a newer one reads a file without them", async () => {
    const w = await world();
    const neu = await w.mk("dev-new");
    const data = crypto.getRandomValues(new Uint8Array(1300));
    const withPrev = await neu.upload(memorySource(data), "mit.jpg", ROOT_ID, { previews: Promise.resolve([img("t"), img("p")]) });
    // Older client: its transport knows nothing of extra attachments.
    const old = await w.mk("dev-old", oldTransport(w.transport));
    await old.pull();
    const s = sink();
    await old.download(withPrev.nodeId, s);
    expect(Buffer.from(s.data()).equals(Buffer.from(data))).toBe(true);
    // ... and uploads a file the old way: no previews.
    const data2 = crypto.getRandomValues(new Uint8Array(700));
    const plain = await old.upload(memorySource(data2), "ohne.jpg", ROOT_ID);
    await neu.pull();
    expect(await neu.readPreview(plain.version.manifestRef, "t")).toBeNull();
    expect(await neu.previewsOf(plain.version.manifestRef)).toEqual({});
    const s2 = sink();
    await neu.download(plain.nodeId, s2);
    expect(Buffer.from(s2.data()).equals(Buffer.from(data2))).toBe(true);
    // A store without extras (old transport) uploads without previews even when asked: no failure.
    const r3 = await old.upload(memorySource(data2), "ohne2.jpg", ROOT_ID, { previews: Promise.resolve([img("t")]) });
    await neu.pull();
    expect(await neu.readPreview(r3.version.manifestRef, "t")).toBeNull();
  });

  it("a failed or oversized preview never fails the upload", async () => {
    const w = await world();
    const a = await w.mk("dev-A");
    const r1 = await a.upload(memorySource(new Uint8Array(600)), "a.jpg", ROOT_ID, { previews: Promise.reject(new Error("decode failed")) });
    expect(await a.readPreview(r1.version.manifestRef, "t")).toBeNull();
    const r2 = await a.upload(memorySource(new Uint8Array(600)), "b.jpg", ROOT_ID, { previews: Promise.resolve([img("t", PREVIEW_LIMITS.t.maxBytes + 10), img("p", 5000)]) });
    expect(await a.readPreview(r2.version.manifestRef, "t")).toBeNull();
    expect((await a.readPreview(r2.version.manifestRef, "p"))?.data.byteLength).toBe(5000);
  });

  it("add previews to an existing file: the manifest stays byte for byte, nothing in the log, kinds kept", async () => {
    const w = await world();
    const a = await w.mk("dev-A");
    const data = crypto.getRandomValues(new Uint8Array(900));
    const r = await a.upload(memorySource(data), "alt.jpg", ROOT_ID);
    const loc = decodeManifestRef(r.version.manifestRef);
    const mid = (loc.at as { messageId: string; attachmentId: string }).messageId;
    const before = Buffer.from(w.transport.messages.get(mid)!.attachments[0]!.data);
    const head = a.replica.headSeq;
    expect(await a.addPreviews(r.version.manifestRef, [img("t", 1111)])).toEqual(["t"]);
    // Again: t is there already (kept), p is added.
    expect(await a.addPreviews(r.version.manifestRef, [img("t", 2222), img("p", 3333)])).toEqual(["p"]);
    const msg = w.transport.messages.get(mid)!;
    expect(msg.attachments.length).toBe(3);
    expect(msg.attachments[0]!.id).toBe((loc.at as { attachmentId: string }).attachmentId);
    expect(Buffer.from(msg.attachments[0]!.data).equals(before)).toBe(true);
    expect(a.replica.headSeq).toBe(head);
    const b = await w.mk("dev-B");
    await b.pull();
    expect((await b.readPreview(r.version.manifestRef, "t"))?.data.byteLength).toBe(1111);
    expect((await b.readPreview(r.version.manifestRef, "p"))?.data.byteLength).toBe(3333);
    const s = sink();
    await b.download(r.nodeId, s);
    expect(Buffer.from(s.data()).equals(Buffer.from(data))).toBe(true);
  });

  it("cleanup: deleting the manifest's message takes the previews along", async () => {
    const w = await world();
    const a = await w.mk("dev-A");
    const r = await a.upload(memorySource(new Uint8Array(800)), "weg.jpg", ROOT_ID, { previews: Promise.resolve([img("t"), img("p")]) });
    const loc = decodeManifestRef(r.version.manifestRef);
    const msg = w.transport.messages.get((loc.at as { messageId: string }).messageId)!;
    const ids = msg.attachments.map((x) => x.id);
    await w.transport.deleteMessage({ id: loc.at.locationId, url: "" }, (loc.at as { messageId: string }).messageId);
    for (const id of ids) await expect(w.transport.fetchCdn(`mem://cdn/${id}?sig=1`)).rejects.toThrow(/404/);
  });

  it("moving a channel copies the previews with the manifest", async () => {
    const w = await world();
    const a = await w.mk("dev-A", w.transport, w.store);
    const files: { id: string; ref: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await a.upload(memorySource(crypto.getRandomValues(new Uint8Array(700))), `p${i}.jpg`, ROOT_ID, { previews: Promise.resolve([img("t", 1000 + i), img("p", 4000 + i)]) });
      files.push({ id: r.nodeId, ref: r.version.manifestRef });
    }
    const W = H[0]!.id;
    const onW = files.filter((f) => decodeManifestRef(f.ref).at.locationId === W);
    expect(onW.length).toBeGreaterThan(0);
    const mover = new ChannelMover({ client: a, store: w.store, vault: w.vault, key: w.key, accountId: ACCT, transport: w.transport, log: w.arb("dev-A"), now: () => Date.now() });
    const s = await mover.run(W);
    expect(s.state).toBe("done");
    const b = await w.mk("dev-B");
    await b.pull();
    for (const [i, f] of files.entries()) {
      const ref = b.store.getNode(f.id)!.content!.manifestRef;
      expect(decodeManifestRef(ref).at.locationId).not.toBe(W);
      expect((await b.readPreview(ref, "t"))?.data.byteLength).toBe(1000 + i);
      expect((await b.readPreview(ref, "p"))?.data.byteLength).toBe(4000 + i);
    }
  });
});
