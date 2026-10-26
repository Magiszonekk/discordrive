// Extras (previews, AI descriptions) whose derived name starts with "_": Discord drops leading underscores
// from attachment names. The upload must not fail on it (a disk upload looped on it forever), and the
// preview must be found again by every reader.
import { afterEach, describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, DiscordWebhookTransport, LocalArbiter, MetadataClient, extraKey, memorySource, previewKeys, type PreviewImage } from "../src/index.js";
import { FakeDiscord } from "../src/node/index.js";

let fake: FakeDiscord | null = null;
afterEach(async () => void (await fake?.close()));

/** A file key whose thumbnail or preview name starts with "_" (about one in 32 keys). */
async function underscoreKey(): Promise<string> {
  for (;;) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    let s = "";
    for (const x of raw) s += String.fromCharCode(x);
    const b64 = btoa(s);
    const k = await previewKeys(b64);
    if (k.names.t.startsWith("_") || k.names.p.startsWith("_")) return b64;
  }
}

describe("extras named with a leading underscore", () => {
  it("extraKey drops the extension and leading underscores", () => {
    expect(extraKey("_r90gl-TjaHmjTHFQPSTE3.txt")).toBe("r90gl-TjaHmjTHFQPSTE3");
    expect(extraKey("r90gl-TjaHmjTHFQPSTE3.txt")).toBe("r90gl-TjaHmjTHFQPSTE3");
    expect(extraKey("__ab")).toBe("ab");
    expect(extraKey("a_b.txt")).toBe("a_b");
  });

  it("FakeDiscord drops leading underscores like Discord does", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    const h = fake.addWebhook("chan-u");
    const t = new DiscordWebhookTransport({ apiOrigin: origin });
    const r = await t.postFiles!({ id: h.id, url: h.url }, new Uint8Array([1]), "m.txt", [{ filename: "_abc.txt", data: new Uint8Array([2]) }]);
    expect(r.extras.map((x) => x.filename)).toEqual(["abc.txt"]);
  });

  it("an upload whose preview name starts with _ completes, and the preview is read back", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    const h = fake.addWebhook("chan-u2");
    const t = new DiscordWebhookTransport({ apiOrigin: origin });
    const c = new MetadataClient({ device: { id: "dev-u", name: "u" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [{ id: h.id, url: h.url }], chunkSize: 100_000, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }) });
    const key = await underscoreKey();
    // The upload's file key is random: drawn until the derived names have a leading "_" (as for the file
    // that blocked the disk's queue).
    const fileCrypto = await import("../src/file-crypto.js");
    const orig = fileCrypto.newFileKey;
    const spy = (await import("vitest")).vi.spyOn(fileCrypto, "newFileKey").mockImplementation(async () => {
      const k = await orig();
      return { ...k, rawB64: key, rootKey: await crypto.subtle.importKey("raw", Uint8Array.from(atob(key), (ch) => ch.charCodeAt(0)), { name: "AES-GCM" }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]) };
    });
    try {
      const png = (w: number, h: number): PreviewImage => ({ kind: "t", mime: "image/jpeg", width: w, height: h, data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]) });
      const pics: PreviewImage[] = [png(320, 240), { ...png(1280, 960), kind: "p" }];
      const up = await c.upload(memorySource(new Uint8Array(37_893).fill(3)), "m57-e.jpg", undefined, { previews: Promise.resolve(pics) });
      expect(up.version.manifestRef).toBeTruthy();
      const keys = await previewKeys(key);
      const kinds = (["t", "p"] as const).filter((k) => keys.names[k].startsWith("_"));
      expect(kinds.length).toBeGreaterThan(0);
      for (const k of ["t", "p"] as const) {
        const got = await c.readPreview(up.version.manifestRef, k);
        expect(got?.width).toBe(k === "t" ? 320 : 1280);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
