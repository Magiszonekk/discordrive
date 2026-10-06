import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { LocalArbiter, MemoryTransport, MetadataClient, handleStreamRequest, memorySource, parseRange } from "../src/index.js";

async function setup(size: number, chunkSize = 1000) {
  const transport = new MemoryTransport();
  const c = new MetadataClient({ device: { id: "dev-s", name: "s" }, arbiter: new LocalArbiter(new Sequencer()), transport, webhooks: [{ id: "1", url: "mem://" }], chunkSize, sleep: async () => {} });
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + 3) & 255;
  const up = await c.upload(memorySource(data), "film.mp4");
  return { c, data, transport, up };
}

describe("range reads for streaming (koncept §3.1)", () => {
  it("returns exactly the requested bytes across fragment borders, fetching only overlapping fragments", async () => {
    const { c, data, transport, up } = await setup(10_500);
    let cdn = 0;
    const orig = transport.fetchCdn.bind(transport);
    transport.fetchCdn = async (u) => (cdn++, orig(u));
    for (const [s, e] of [[0, 0], [999, 1000], [2500, 4999], [10_000, 10_499], [0, 10_499], [123, 20_000]] as const) {
      cdn = 0;
      const r = await c.readRange(up.nodeId, s, e);
      const ee = Math.min(e, 10_499);
      expect(r.data).toEqual(data.subarray(s, ee + 1));
      const fragments = Math.floor(ee / 1000) - Math.floor(s / 1000) + 1;
      expect(cdn).toBe(fragments + (s === 0 && e === 0 ? 1 : 0)); // manifest fetched once, then cached
    }
    expect(c.manifestLoads).toBe(1);
    const cache = new Map<string, Uint8Array>();
    await c.readRange(up.nodeId, 0, 1999, cache);
    cdn = 0;
    await c.readRange(up.nodeId, 500, 1500, cache);
    expect(cdn).toBe(0); // manifest and fragments from cache
  });

  it("parseRange follows RFC 9110", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-1", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
    expect(parseRange("bytes=10-", 100, 20)).toEqual({ start: 10, end: 29 });
  });

  it("service-worker handler answers 206 with Content-Range, 416 outside, 404 for unknown/trashed", async () => {
    const { c, data, up } = await setup(5000);
    const req = (range?: string, id = up.nodeId) => new Request(`https://app.local/ddn/file/${id}`, { headers: range ? { range } : {} });
    const r1 = (await handleStreamRequest(req("bytes=1500-2600"), c))!;
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe("bytes 1500-2600/5000");
    expect(r1.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(data.subarray(1500, 2601));
    const r2 = (await handleStreamRequest(req(), c))!;
    expect(r2.status).toBe(200);
    expect((await r2.arrayBuffer()).byteLength).toBe(5000);
    expect((await handleStreamRequest(req("bytes=6000-"), c))!.status).toBe(416);
    expect((await handleStreamRequest(req(undefined, "nope-nope-nope"), c))!.status).toBe(404);
    expect(await handleStreamRequest(new Request("https://app.local/other"), c)).toBeNull();
    await c.commitOp({ type: "trash", nodeId: up.nodeId }, "trash");
    expect((await handleStreamRequest(req(), c))!.status).toBe(404);
  });
});
