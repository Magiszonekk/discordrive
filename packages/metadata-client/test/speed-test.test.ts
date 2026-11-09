// The speed test (Settings → Network): fragments go through the account's channels and come back, and the
// account is not touched — no operation in the log, no node, no message left on Discord, also after a cancel
// or a test cut short (cleaned at the next start); the per-channel pacing applies as to an upload.
import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, LocalArbiter, MemoryTransport, MetadataClient, RateLimitedError, cleanupLeftovers, discordSpeed, lineSpeed, removeTestMessage, SPEED_BEAT_MS, speedHints, type ResumeStore, type SpeedTestProgress } from "../src/index.js";

function memStore(): ResumeStore & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
    entries: async (p) => [...m].filter(([k]) => k.startsWith(p)),
    delPrefix: async (p) => void [...m.keys()].filter((k) => k.startsWith(p)).forEach((k) => m.delete(k)),
  };
}
function setup(pacer = new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 })) {
  const t = new MemoryTransport();
  const seq = new Sequencer();
  const hooks = Array.from({ length: 3 }, (_, i) => ({ id: `15500000000000070${i}`, url: `mem://hook/${i}`, channelId: `chan-${i}` }));
  const c = new MetadataClient({ device: { id: "dev-s", name: "s" }, arbiter: new LocalArbiter(seq), transport: t, webhooks: hooks, chunkSize: 4096, pacer, sleep: async () => {} });
  return { t, c, seq };
}

describe("speed test", () => {
  it("up and down through the channels, every message deleted, no operation in the log", async () => {
    const { t, c, seq } = setup();
    const store = memStore();
    const headBefore = c.replica.headSeq;
    const r = await discordSpeed(c, store, { count: 12, size: 50_000 });
    expect(r.up).toBeGreaterThan(0);
    expect(r.down).toBeGreaterThan(0);
    expect(r.posted).toHaveLength(12);
    expect(r.deleted).toBe(12);
    expect(r.leftOver).toBe(0);
    expect(t.messages.size).toBe(0);
    expect(store.m.size).toBe(0);
    // Nothing in the account: no log entry, no node.
    expect((await seq.read(0, 100)).length).toBe(0);
    expect(c.replica.headSeq).toBe(headBefore);
    expect(c.list().length).toBe(0);
    // Spread over the three channels (round-robin as an upload).
    expect(new Set(r.posted.map((p) => (p as { locationId: string }).locationId)).size).toBe(3);
  });

  it("a cancel deletes what was posted", async () => {
    const { t, c } = setup();
    const store = memStore();
    const ac = new AbortController();
    let n = 0;
    const post = t.postFile.bind(t);
    t.postFile = async (...a) => {
      if (++n === 5) ac.abort();
      return post(...a);
    };
    await expect(discordSpeed(c, store, { count: 20, size: 20_000, signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(t.messages.size).toBe(0);
    expect(store.m.size).toBe(0);
  });

  it("a test cut short (the app closed) is cleaned at the next start from the saved list", async () => {
    const { t, c } = setup();
    const store = memStore();
    // Deletions fail now (the app is closing): the list stays.
    const del = t.deleteMessage.bind(t);
    t.deleteMessage = async () => {
      throw new TypeError("Failed to fetch");
    };
    const r = await discordSpeed(c, store, { count: 6, size: 20_000, only: "up" });
    expect(r.leftOver).toBe(6);
    expect(t.messages.size).toBe(6);
    expect([...store.m.keys()].every((k) => k.startsWith("st:"))).toBe(true);
    // Next start.
    t.deleteMessage = del;
    expect(await cleanupLeftovers(c, store)).toBe(6);
    expect(t.messages.size).toBe(0);
    expect(store.m.size).toBe(0);
  });

  it("deletes are tried again after a 429; a failed one stays on the list for the next start", async () => {
    const p = { provider: "discord", locationId: "w", channelId: "c", messageId: "m1", attachmentId: "a" } as never;
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new RateLimitedError(20, "shared", false);
      return "deleted";
    };
    expect(await removeTestMessage(flaky, p)).toBe(true);
    expect(calls).toBe(3);
    expect(await removeTestMessage(async () => Promise.reject(new Error("HTTP 404 Unknown Message")), p)).toBe(true);
    // Never works: false after the tries, and cleanupLeftovers keeps the entry.
    const store = memStore();
    await store.put("st:0", p);
    const failing = { blobs: { remove: async () => Promise.reject(new RateLimitedError(10, "shared", false)) } } as never;
    expect(await cleanupLeftovers(failing, store)).toBe(0);
    expect((await store.entries("st:")).length).toBe(1);
    const working = { blobs: { remove: async () => "deleted" } } as never;
    expect(await cleanupLeftovers(working, store)).toBe(1);
    expect((await store.entries("st:")).length).toBe(0);
  }, 30_000);
  it("progress keeps coming while a slow piece is on its way: a clock and the pieces done, every stage", async () => {
    const { t, c } = setup();
    const post = t.postFile.bind(t);
    // One post takes 2.5 s: before, nothing was reported until it ended (a test looked stuck).
    t.postFile = async (...a) => {
      await new Promise((r) => setTimeout(r, 2500));
      return post(...a);
    };
    const ev: SpeedTestProgress[] = [];
    const t0 = Date.now();
    await discordSpeed(c, null, { count: 1, size: 10_000, onProgress: (p) => ev.push({ ...p }) });
    const up = ev.filter((e) => e.stage === "up");
    // Reported at the start and then about every second while the piece is posted.
    expect(up[0]).toMatchObject({ pieces: 0, of: 1 });
    expect(up.filter((e) => e.pieces === 0).length).toBeGreaterThanOrEqual(3);
    expect(up.filter((e) => e.pieces === 0).at(-1)!.ms).toBeGreaterThanOrEqual(1900);
    expect(up.at(-1)).toMatchObject({ pieces: 1, of: 1 });
    // The stages in order; the download is shown before its links are fetched; the clean-up counts pieces.
    expect([...new Set(ev.map((e) => e.stage))]).toEqual(["up", "down", "cleanup"]);
    expect(ev.find((e) => e.stage === "down")).toMatchObject({ pieces: 0, of: 1 });
    expect(ev.at(-1)).toMatchObject({ stage: "cleanup", pieces: 1, of: 1 });
    // No beat after the end.
    const n = ev.length;
    await new Promise((r) => setTimeout(r, SPEED_BEAT_MS + 300));
    expect(ev.length).toBe(n);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("the line test reports during the transfer (not only after each request) and stops on time", async () => {
    // A slow download stream: 25 chunks of 100 kB, one every 200 ms (5 s for one request; the test runs 1.5 s).
    const f = (async (url: string, init?: RequestInit) => {
      if (/__up/.test(url)) {
        await new Promise((r) => setTimeout(r, 400));
        return new Response("ok");
      }
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(ctl) {
          await new Promise((r) => setTimeout(r, 200));
          if (init?.signal?.aborted || i++ >= 25) return ctl.close();
          ctl.enqueue(new Uint8Array(100_000));
        },
      });
      return new Response(body);
    }) as typeof fetch;
    const ev: SpeedTestProgress[] = [];
    const r = await lineSpeed(f, 1.5, undefined, (p) => ev.push({ ...p }));
    const down = ev.filter((e) => e.stage === "line-down");
    expect(down[0]!.ms).toBeLessThan(100);
    expect(down[0]!.planMs).toBe(1500);
    // Several reports with bytes before the first request could end.
    expect(down.filter((e) => e.bytes > 0).length).toBeGreaterThanOrEqual(3);
    expect(r.down).toBeGreaterThan(0);
    expect(ev.some((e) => e.stage === "line-up")).toBe(true);
  }, 20_000);

  it("the line test: small upload bodies, requests cut at the planned time, a refusal is an error (not 0 MB/s)", async () => {
    const sizes: number[] = [];
    // A very slow line: one request never ends by itself (only the cut stops it).
    const slow = (async (url: string, init?: RequestInit) => {
      if (/__up/.test(url)) sizes.push((init!.body as Uint8Array).byteLength);
      await new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      return new Response("x");
    }) as typeof fetch;
    const t0 = Date.now();
    await expect(lineSpeed(slow, 1)).rejects.toThrow(/moved no data/);
    expect(Date.now() - t0).toBeLessThan(4000); // down: 1 s + the cut margin, no minutes
    // The test server refuses (429): an error the UI words.
    const refuse = (async () => new Response("error code: 1015", { status: 429 })) as typeof fetch;
    await expect(lineSpeed(refuse, 0.5)).rejects.toThrow(/refused/);
    // Upload bodies stay small (a big one kept a browser worker silent for seconds).
    const ok = (async (url: string, init?: RequestInit) => {
      if (/__up/.test(url)) sizes.push((init!.body as Uint8Array).byteLength);
      await new Promise((r) => setTimeout(r, 20));
      return /__up/.test(url) ? new Response("ok") : new Response(new Uint8Array(100_000));
    }) as typeof fetch;
    const r = await lineSpeed(ok, 0.8);
    expect(r.up).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Math.min(...sizes)).toBe(256 * 1024);
  }, 20_000);

  it("the per-channel pacing applies (as to an upload)", async () => {
    const pacer = new ChannelPacer({ perMin: 30, maxPerMin: 30, burst: 2 });
    const { c } = setup(pacer);
    await discordSpeed(c, null, { count: 6, size: 1000, only: "up" });
    // 3 channels × burst 2 = 6 posts without waiting; one more round would wait for the bucket.
    expect(pacer.stats.acquired).toBe(6);
  });

  it("hints: channels limit the upload, the line is full, the browser's download", () => {
    expect(speedHints({ line: { down: 100, up: 100 }, up: 20, down: 90, channels: 4, rateLimited: 0, errors: 0, browser: false, metered: false }).map((h) => h.k)).toEqual(["channels", "line-full"]);
    expect(speedHints({ line: { down: 200, up: 40 }, up: 38, down: 18, channels: 10, rateLimited: 0, errors: 0, browser: true, metered: false }).map((h) => h.k)).toEqual(["line-full", "browser-h3"]);
    expect(speedHints({ line: null, up: 10, down: 10, channels: 2, rateLimited: 3, errors: 1, browser: false, metered: true }).map((h) => h.k)).toEqual(["metered", "rate-limited", "errors", "channels"]);
    // Far above an older, slower line test: not "the line is full" (it was 1099% before).
    expect(speedHints({ line: { down: 1, up: 1 }, up: 11, down: 11, channels: 1, rateLimited: 0, errors: 0, browser: false, metered: false }).filter((h) => h.k === "line-full")).toEqual([]);
  });
});
