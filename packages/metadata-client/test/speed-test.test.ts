// The speed test (Settings → Network): fragments go through the account's channels and come back, and the
// account is not touched — no operation in the log, no node, no message left on Discord, also after a cancel
// or a test cut short (cleaned at the next start); the per-channel pacing applies as to an upload.
import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, LocalArbiter, MemoryTransport, MetadataClient, RateLimitedError, cleanupLeftovers, discordSpeed, removeTestMessage, speedHints, type ResumeStore } from "../src/index.js";

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
  });
});
