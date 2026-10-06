import { describe, expect, it } from "vitest";
import { checkInvariants, replay, canonicalState, ROOT_ID, Sequencer } from "@ddv4/sync-core";
import {
  ChannelPacer,
  LocalArbiter,
  MemoryTransport,
  MetadataClient,
  RateLimitedError,
  decodeManifestRef,
  memorySource,
  sha256Hex,
  type ByteSink,
  type WebhookRef,
} from "../src/index.js";

const DEV = { id: "dev-cli-1", name: "cli" };
const HOOKS: WebhookRef[] = [
  { id: "111111111111111111", url: "mem://hook/1" },
  { id: "222222222222222222", url: "mem://hook/2" },
];

function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (d) => void parts.push(new Uint8Array(d)),
    data: () => {
      const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) out.set(p, (o += p.byteLength) - p.byteLength);
      return out;
    },
  };
}

/** Virtual clock: sleeping advances time instantly (no real waits, no busy loops). */
function clock(start = Date.UTC(2026, 9, 6)) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function setup(over: Partial<ConstructorParameters<typeof MetadataClient>[0]> = {}) {
  const c = clock();
  const transport = new MemoryTransport();
  const arbiter = new LocalArbiter(new Sequencer({ now: c.now }));
  const client = new MetadataClient({
    device: DEV,
    arbiter,
    transport,
    webhooks: HOOKS.map((h) => ({ ...h })),
    chunkSize: 1000,
    ...c,
    ...over,
  });
  return { transport, arbiter, client, clock: c };
}

describe("smallest slice: upload -> log -> download (one device)", () => {
  it("round-trips a multi-fragment file and verifies the plaintext hash", async () => {
    const { transport, arbiter, client } = setup();
    const data = bytes(4321);
    const up = await client.upload(memorySource(data), "Zdjęcie.bin");

    expect(up.chunks).toBe(5);
    expect(transport.posts).toBe(6); // 5 fragments + manifest
    // fragments are spread over both webhooks/channels
    const hooksUsed = new Set([...transport.messages.values()].map((m) => m.webhookId));
    expect(hooksUsed.size).toBe(2);

    // log: upload_begin, then one group [upload_commit, create]
    const log = await arbiter.read(0);
    expect(log.map((e) => e.op.type)).toEqual(["upload_begin", "group"]);
    expect(log[1]!.leaseGuard).toEqual([up.uploadId]);

    const node = client.store.getNode(up.nodeId)!;
    expect(node.parentId).toBe(ROOT_ID);
    expect(node.name).toBe("Zdjęcie.bin");
    expect(node.content!.plaintextSha256).toBe(await sha256Hex(data));
    expect(client.store.getUpload(up.uploadId)!.status).toBe("bound");
    expect(checkInvariants(client.store)).toEqual([]);

    const s = sink();
    await client.download(up.nodeId, s);
    expect(await sha256Hex(s.data())).toBe(await sha256Hex(data));
    expect(s.data()).toEqual(data);
  });

  it("nothing on Discord is plaintext: fragments and manifest are ciphertext", async () => {
    const { transport, client } = setup();
    const data = new TextEncoder().encode("TAJNE ".repeat(500));
    await client.upload(memorySource(data), "tajne.txt");
    for (const m of transport.messages.values()) {
      const text = new TextDecoder("latin1").decode(m.attachments[0]!.data);
      expect(text).not.toContain("TAJNE");
      expect(text).not.toContain("chunks");
    }
  });

  it("empty file and exact multiple of the chunk size", async () => {
    const { client } = setup();
    for (const n of [0, 1000, 3000]) {
      const data = bytes(n, n + 7);
      const up = await client.upload(memorySource(data), `f${n}.bin`);
      expect(up.chunks).toBe(Math.max(1, n / 1000));
      const s = sink();
      await client.download(up.nodeId, s);
      expect(s.data()).toEqual(data);
    }
  });

  it("a second device rebuilds the same index from the log and downloads the file", async () => {
    const { transport, arbiter, client, clock: c } = setup();
    const data = bytes(2500, 3);
    const up = await client.upload(memorySource(data), "a.bin");
    const other = new MetadataClient({ device: { id: "dev-2", name: "pc" }, arbiter, transport, webhooks: HOOKS, ...c });
    await other.pull();
    expect(canonicalState(other.store)).toBe(canonicalState(client.store));
    expect(canonicalState(replay(await arbiter.read(0)).store)).toBe(canonicalState(client.store));
    const s = sink();
    await other.download(up.nodeId, s);
    expect(s.data()).toEqual(data);
  });

  it("a corrupted fragment is detected", async () => {
    const { transport, client } = setup();
    const up = await client.upload(memorySource(bytes(2500, 5)), "a.bin");
    const loc = decodeManifestRef(client.store.getNode(up.nodeId)!.content!.manifestRef);
    const { manifest } = await client.loadManifest(client.store.getNode(up.nodeId)!.content!.manifestRef);
    expect(loc.at.attachmentId).not.toBe(manifest.chunks[1]!.placements![0]!.attachmentId);
    transport.corrupt(manifest.chunks[1]!.placements![0]!.attachmentId!);
    await expect(client.download(up.nodeId, sink())).rejects.toThrow(/hash mismatch/);
  });

  it("429 (channel scope) slows the pacer and the upload still completes", async () => {
    const { transport, client } = setup();
    let n = 0;
    transport.beforePost = () => {
      if (++n % 3 === 0) throw new RateLimitedError(800, "shared", false);
    };
    const data = bytes(5000, 9);
    const up = await client.upload(memorySource(data), "a.bin");
    expect(client.pacer.stats.shared429).toBeGreaterThan(0);
    expect(up.posts).toBeGreaterThan(up.chunks + 1);
    const s = sink();
    await client.download(up.nodeId, s);
    expect(s.data()).toEqual(data);
  });

  it("a failed fragment upload leaves an open upload and no file", async () => {
    const { transport, arbiter, client } = setup({ maxRetries: 1 });
    transport.beforePost = (i) => {
      if (i >= 2) throw new Error("boom");
    };
    await expect(client.upload(memorySource(bytes(5000)), "a.bin")).rejects.toThrow(/boom/);
    const log = await arbiter.read(0);
    expect(log.map((e) => e.op.type)).toEqual(["upload_begin"]);
    expect([...client.store.childIds(ROOT_ID)]).toEqual([]);
    // the lease was released, so a cleaner may take it over (rule 8)
    const uploadId = (log[0]!.op as { uploadId: string }).uploadId;
    expect(await arbiter.renewLease(uploadId, "dev-cleaner")).toBe(true);
  });

  it("names are NFC-normalized before the op is made (Q5)", async () => {
    const { client } = setup();
    const up = await client.upload(memorySource(bytes(10)), "Zaz\u0307o\u0301\u0142c\u0301.txt");
    expect(client.store.getNode(up.nodeId)!.name).toBe("Za\u017c\u00f3\u0142\u0107.txt");
  });
});

describe("ChannelPacer", () => {
  it("paces one channel to perMin after the burst, channels are independent", async () => {
    let t = 0;
    const p = new ChannelPacer({ perMin: 30, burst: 2, now: () => t, sleep: async (ms) => void (t += ms) });
    for (let i = 0; i < 2; i++) await p.acquire("A");
    expect(t).toBe(0);
    for (let i = 0; i < 30; i++) await p.acquire("A");
    // 30 more at 30/min = 60 s (2 s apart)
    expect(t).toBeGreaterThanOrEqual(59_000);
    expect(t).toBeLessThanOrEqual(61_000);
    const before = t;
    await p.acquire("B");
    expect(t).toBe(before);
  });

  it("a shared 429 blocks for retry_after and lowers the rate; successes recover it", async () => {
    let t = 0;
    const p = new ChannelPacer({ perMin: 30, maxPerMin: 36, now: () => t, sleep: async (ms) => void (t += ms) });
    p.onRateLimited("A", 1500, "shared");
    expect(p.rate("A")).toBeCloseTo(24);
    await p.acquire("A");
    expect(t).toBeGreaterThanOrEqual(1500);
    for (let i = 0; i < 100; i++) p.onSuccess("A");
    expect(p.rate("A")).toBe(36);
  });
});
