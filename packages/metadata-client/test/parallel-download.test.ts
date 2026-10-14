// Parallel download (zlecenie 2026-10-13-transfer §3): fragments fetched out of order are written in
// order (whole-file SHA-256 checked), at most `downloadConcurrency` in flight, the first failure stops
// the rest and is the error the caller sees, a cancel stops everything; upload concurrency follows the
// channels; Range reads use the same limit.
import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, LocalArbiter, MemoryTransport, MetadataClient, memorySource, sha256Hex, type ByteSink } from "../src/index.js";

function setup(o: { channels?: number; downloadConcurrency?: number; concurrency?: number } = {}) {
  const t = new MemoryTransport();
  const hooks = Array.from({ length: o.channels ?? 2 }, (_, i) => ({ id: `15500000000000070${String(i).padStart(2, "0")}`, url: `mem://hook/${i}`, channelId: `chan-${i}` }));
  const c = new MetadataClient({ device: { id: "dev-p", name: "p" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: hooks, chunkSize: 1000, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), downloadConcurrency: o.downloadConcurrency, concurrency: o.concurrency, sleep: async () => {} });
  return { t, c };
}

function data(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 255;
  return b;
}

function sink(): ByteSink & { parts: Uint8Array[]; all(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { parts, write: async (d) => void parts.push(new Uint8Array(d)), all: () => Buffer.concat(parts) };
}

describe("parallel download", () => {
  it("random fetch delays: written in order, SHA-256 OK, at most N in flight", async () => {
    const { t, c } = setup({ downloadConcurrency: 4 });
    const src = data(25_500);
    const up = await c.upload(memorySource(src), "f.bin");
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    const orig = t.fetchCdn.bind(t);
    t.fetchCdn = async (u) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, Math.random() * 15));
      inFlight--;
      return orig(u);
    };
    const s = sink();
    const progress: number[] = [];
    await c.download(up.nodeId, { write: async (d) => (order.push(d.byteLength), s.write(d)) }, { onProgress: (d) => void progress.push(d) });
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(src));
    expect(order.length).toBe(26);
    expect(peak).toBe(4);
    expect(progress.at(-1)).toBe(25_500);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("a failing fragment stops the rest and its error is the one thrown; nothing after it is written", async () => {
    const { t, c } = setup({ downloadConcurrency: 4 });
    const up = await c.upload(memorySource(data(20_000)), "f.bin");
    const orig = t.fetchCdn.bind(t);
    // Fragment 5's attachment is gone for good (every retry fails); the others answer slowly.
    const bad = new Set<string>();
    let calls = 0;
    const atts = t.getAttachments.bind(t);
    let seen = 0;
    t.getAttachments = async (h, m) => {
      const a = await atts(h, m);
      if (++seen === 7) bad.add(a[0]!.id); // 1st GET is the manifest, then fragments 0, 1, … in launch order
      return a;
    };
    t.fetchCdn = async (u) => {
      calls++;
      if ([...bad].some((id) => u.includes(`/${id}?`))) throw new Error("boom 5");
      await new Promise((r) => setTimeout(r, 10));
      return orig(u);
    };
    const s = sink();
    await expect(c.download(up.nodeId, s)).rejects.toThrow(/boom 5/);
    // Fragments before it are written in order, nothing after it; the other fetches were stopped.
    expect(s.parts.length).toBeLessThanOrEqual(5);
    expect(calls).toBeLessThan(20 + 4);
  });

  it("cancel stops the fetches in flight", async () => {
    const { t, c } = setup({ downloadConcurrency: 3 });
    const up = await c.upload(memorySource(data(30_000)), "f.bin");
    const orig = t.fetchCdn.bind(t);
    let calls = 0;
    t.fetchCdn = async (u) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return orig(u);
    };
    const ac = new AbortController();
    const s = sink();
    const p = c.download(up.nodeId, s, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const at = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls - at).toBeLessThanOrEqual(3);
    expect(calls).toBeLessThan(30);
  });

  it("upload concurrency: max(3, 2 × channels), capped; a setting overrides it", async () => {
    expect(setup({ channels: 1 }).c.uploadConcurrency).toBe(3);
    expect(setup({ channels: 4 }).c.uploadConcurrency).toBe(8);
    expect(setup({ channels: 12 }).c.uploadConcurrency).toBe(16);
    const { c } = setup({ channels: 4, concurrency: 2 });
    expect(c.uploadConcurrency).toBe(2);
    c.setConcurrency({ upload: null, download: 6 });
    expect(c.uploadConcurrency).toBe(8);
    expect(c.downloadConcurrency).toBe(6);
  });

  it("Range over several fragments fetches them in parallel and returns the right bytes", async () => {
    const { t, c } = setup({ downloadConcurrency: 4 });
    const src = data(10_000);
    const up = await c.upload(memorySource(src), "f.bin");
    let inFlight = 0;
    let peak = 0;
    const orig = t.fetchCdn.bind(t);
    t.fetchCdn = async (u) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return orig(u);
    };
    const r = await c.readRange(up.nodeId, 1500, 7499);
    expect(Buffer.from(r.data).equals(Buffer.from(src.subarray(1500, 7500)))).toBe(true);
    expect(peak).toBe(4);
  });
});
