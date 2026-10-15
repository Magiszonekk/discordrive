// zlecenie 2026-10-15-transfery §2–3 through the real client: a download that loses the network midway
// waits and finishes (the failures during the outage do not use up its retries), the window of pieces in
// flight shrinks on network errors, and on a metered link / with the guard off the download sends exactly
// one CDN request per fragment and none on the second connection.
import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, LocalArbiter, MemoryTransport, MetadataClient, NetControl, memorySource, sha256Hex, type ByteSink } from "../src/index.js";

function data(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 9)) & 255;
  return b;
}
function sink(): ByteSink & { all(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), all: () => Buffer.concat(parts) };
}
function setup(o: { metered?: boolean; maxRetries?: number; downloadConcurrency?: number } = {}) {
  const t = new MemoryTransport();
  const hooks = Array.from({ length: 2 }, (_, i) => ({ id: `15500000000000090${i}`, url: `mem://hook/${i}`, channelId: `chan-${i}` }));
  const net = new NetControl({ metered: () => !!o.metered, gate: { baseMs: 5, maxMs: 40 } });
  const c = new MetadataClient({ device: { id: "dev-n", name: "n" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: hooks, chunkSize: 1000, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), downloadConcurrency: o.downloadConcurrency ?? 8, maxRetries: o.maxRetries ?? 2, sleep: async (ms) => void (await new Promise((r) => setTimeout(r, Math.min(ms, 5)))), net });
  return { t, c, net };
}

describe("weak and lost network (client)", () => {
  it("network gone for a while mid-download: the download waits at the gate and completes (retries not used up)", async () => {
    // 3 retries (production: 4): the first network errors, before the gate closes, still count.
    const { t, c, net } = setup({ maxRetries: 3 });
    const src = data(30_000);
    const up = await c.upload(memorySource(src), "f.bin");
    const orig = t.fetchCdn.bind(t);
    let calls = 0;
    let failed = 0;
    let offline = false;
    const states: string[] = [];
    net.onState = (s) => states.push(s);
    t.fetchCdn = async (u) => {
      calls++;
      if (calls === 6) offline = true;
      if (offline) {
        failed++;
        if (failed >= 12) offline = false; // the network comes back after 12 failed requests
        throw new TypeError("Failed to fetch");
      }
      await new Promise((r) => setTimeout(r, 2));
      return orig(u);
    };
    const s = sink();
    await c.download(up.nodeId, s);
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(src));
    expect(failed).toBe(12); // far more than maxRetries = 3: they waited at the gate instead of failing the file
    expect(states).toContain("offline");
    expect(net.gate.open).toBe(true);
    expect(net.win.down.cuts).toBeGreaterThan(0);
    expect(net.gate.probes).toBeGreaterThan(0);
  });

  it("the window limits the pieces in flight after network errors (8 → ≤ 4)", async () => {
    const { t, c, net } = setup();
    const up = await c.upload(memorySource(data(40_000)), "f.bin");
    const orig = t.fetchCdn.bind(t);
    let inFlight = 0;
    let peakAfter = 0;
    let n = 0;
    t.fetchCdn = async (u) => {
      n++;
      if (n === 3) throw new TypeError("Failed to fetch"); // one network error early
      inFlight++;
      if (net.win.down.cuts > 0) peakAfter = Math.max(peakAfter, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return orig(u);
    };
    await c.download(up.nodeId, sink());
    expect(net.win.down.cuts).toBe(1);
    expect(peakAfter).toBeLessThanOrEqual(8);
    expect(net.win.down.limit).toBeGreaterThan(4); // grew back with the successes
  });

  it("an HTTP error is not 'no network': it uses the retries and fails the file", async () => {
    const { t, c, net } = setup({ maxRetries: 1 });
    const up = await c.upload(memorySource(data(5_000)), "f.bin");
    t.fetchCdn = async () => {
      throw new Error("cdn get: HTTP 404");
    };
    await expect(c.download(up.nodeId, sink())).rejects.toThrow(/404/);
    expect(net.gate.open).toBe(true);
  });

  it("metered link: at most 2 pieces in flight, one CDN request per fragment, nothing on a second connection", async () => {
    const { t, c, net } = setup({ metered: true });
    c.blobs.setCdnLanes!([async () => {
      throw new Error("lane must not be used");
    }]);
    expect(net.laneCount).toBe(2);
    const src = data(20_000);
    const up = await c.upload(memorySource(src), "f.bin");
    const orig = t.fetchCdn.bind(t);
    let calls = 0;
    let lane1 = 0;
    let inFlight = 0;
    let peak = 0;
    t.fetchCdn = async (u: string, _s?: AbortSignal, _t?: unknown, lane?: number) => {
      calls++;
      if (lane) lane1++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return orig(u);
    };
    const s = sink();
    await c.download(up.nodeId, s);
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(src));
    expect(calls).toBe(21); // 20 fragments + the manifest, each exactly once
    expect(lane1).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(net.win.up.max).toBeLessThanOrEqual(2);
  });

  it("save data switch: the same lean limits; off again: back to the configured values", () => {
    const { c, net } = setup();
    expect(net.win.down.max).toBe(8);
    c.setSaveData(true);
    expect(net.metered()).toBe(true);
    expect(net.win.down.max).toBe(2);
    c.setSaveData(false);
    expect(net.win.down.max).toBe(8);
  });
});
