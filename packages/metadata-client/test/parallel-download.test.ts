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
  const c = new MetadataClient({ device: { id: "dev-p", name: "p" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: hooks, chunkSize: 1000, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), links: { perMin: 1e6, burst: 1e6 }, downloadConcurrency: o.downloadConcurrency, concurrency: o.concurrency, sleep: async () => {} });
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

  it("a slow head fragment does not stall the others (no waves): the slots keep refilling, memory stays bounded", async () => {
    // Owner's log 2026-10-15: with the old limit (fetched + waiting-to-be-written ≤ N), one slow fragment
    // at the head held every slot; nothing new started for ~25 s, then ~30 finished at once.
    const { t, c } = setup({ downloadConcurrency: 4 });
    const src = data(40_500); // 41 fragments of 1000
    const up = await c.upload(memorySource(src), "f.bin");
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    let startedWhileHeadSlow = 0;
    let headDone = false;
    // Fragment 0 is made slow (found by its attachment ID: links arrive out of order, so CDN reads do too).
    const head = (await c.loadManifest(up.version.manifestRef)).manifest.chunks.find((x) => x.index === 0)!.placements![0]!.attachmentId;
    const orig = t.fetchCdn.bind(t);
    t.fetchCdn = async (u) => {
      const isHead = u.includes(`/${head}?`);
      started++;
      if (!headDone && !isHead && started > 1) startedWhileHeadSlow++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        if (isHead) {
          await new Promise((r) => setTimeout(r, 120));
          headDone = true;
        } else await new Promise((r) => setTimeout(r, 5));
        return await orig(u);
      } finally {
        inFlight--;
      }
    };
    const s = sink();
    await c.download(up.nodeId, s);
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(src));
    expect(peak).toBeLessThanOrEqual(4);
    // While fragment 0 was slow, the other 3 slots kept fetching far beyond the first 4 — bounded by the
    // read-ahead window (2 × N, at least 16), not by "N in total".
    expect(startedWhileHeadSlow).toBeGreaterThan(8);
    expect(startedWhileHeadSlow).toBeLessThanOrEqual(16 + 1);
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

  it("concurrency: automatic starts at 4 within max(3, 2 × channels) and 32 (and memory); a setting overrides it", async () => {
    expect(setup({ channels: 1 }).c.uploadConcurrency).toBe(3);
    expect(setup({ channels: 1 }).c.autoCap("up")).toBe(3);
    expect(setup({ channels: 4 }).c.uploadConcurrency).toBe(4);
    expect(setup({ channels: 4 }).c.autoCap("up")).toBe(8);
    expect(setup({ channels: 12 }).c.autoCap("up")).toBe(24);
    expect(setup({ channels: 30 }).c.autoCap("up")).toBe(32); // automatic stays ≤ 32
    expect(setup({ channels: 30 }).c.autoCap("down")).toBe(32);
    expect(setup({ channels: 4, concurrency: 200 }).c.uploadConcurrency).toBe(64); // a setting up to 64
    const { c } = setup({ channels: 4, concurrency: 2 });
    expect(c.uploadConcurrency).toBe(2);
    expect(c.downloadConcurrency).toBe(4);
    expect(c.autoConcurrency).toEqual({ upload: false, download: true });
    c.setConcurrency({ upload: null, download: 6 });
    expect(c.uploadConcurrency).toBe(4);
    expect(c.downloadConcurrency).toBe(6);
    expect(c.autoConcurrency).toEqual({ upload: true, download: false });
    // memory: 8 pieces of ~20 MB at most
    const t = new MemoryTransport();
    const small = new MetadataClient({ device: { id: "d", name: "d" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [{ id: "1550000000000007100", url: "mem://h", channelId: "c" }], memoryBudget: 160 * 1024 * 1024 });
    expect(small.autoCap("down")).toBe(8);
  });

  it("upload: reads + whole-file hash stay in order with 12 in flight and random post delays; 429-slowed channel is skipped", async () => {
    const { t, c } = setup({ channels: 4, concurrency: 12 });
    const src = data(40_500);
    const orig = t.postFile.bind(t);
    t.postFile = async (...a) => (await new Promise((r) => setTimeout(r, Math.random() * 10)), orig(...a));
    const up = await c.upload(memorySource(src), "u.bin");
    expect(up.version.plaintextSha256).toBe(await sha256Hex(src));
    const s = sink();
    await c.download(up.nodeId, s);
    expect(Buffer.from(s.all()).equals(Buffer.from(src))).toBe(true);
    // Channel choice: a channel blocked by a 429 gets nothing while the others have tokens.
    const { t: t2, c: c2 } = setup({ channels: 3, concurrency: 3 });
    c2.pacer.onRateLimited("chan-1", 60_000, "shared");
    await c2.upload(memorySource(data(9_000)), "v.bin");
    const used = new Set([...t2.messages.values()].map((m) => m.channelId));
    expect(used.has("chan-1")).toBe(false);
    expect(used.size).toBe(2);
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
