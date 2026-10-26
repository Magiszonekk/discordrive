// Discord's 429s as seen in production (2026-10-26): a webhook's per-route bucket (GET of a message, 5 per
// webhook) answered with a header retry-after of half an hour while the body and x-ratelimit-reset-after say
// a fraction of a second. Read as half an hour, every bucket hit failed a fragment ("too long to wait out").
import { afterEach, describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, DiscordWebhookTransport, LocalArbiter, MetadataClient, RateLimitedError, discordWaitMs, isCloudflareBlock, memorySource, sha256Hex, type ByteSink } from "../src/index.js";
import { FakeDiscord } from "../src/node/index.js";

const H = (o: Record<string, string>) => new Headers(o);
// The exact answer from production (scope user, the contradicting values).
const prod = { "retry-after": "1812", "x-ratelimit-reset-after": "2", "x-ratelimit-remaining": "0", "x-ratelimit-scope": "user", "x-ratelimit-limit": "5", "content-type": "application/json", via: "1.1 google" };

let fake: FakeDiscord | null = null;
afterEach(async () => void (await fake?.close()));

describe("the wait of a Discord 429", () => {
  it("a bucket's 429 waits the body's retry_after, not the header's half hour", () => {
    expect(discordWaitMs(H(prod), { retry_after: 0.3, global: false })).toEqual({ ms: 300, global: false });
  });
  it("no body value: x-ratelimit-reset-after", () => {
    expect(discordWaitMs(H(prod), null).ms).toBe(2000);
  });
  it("at least 250 ms", () => {
    expect(discordWaitMs(H({ ...prod, "x-ratelimit-reset-after": "0.01" }), { retry_after: 0.01 }).ms).toBe(250);
  });
  it("only the header retry-after: capped at 60 s for a bucket", () => {
    expect(discordWaitMs(H({ "retry-after": "1812", "x-ratelimit-scope": "user" }), null).ms).toBe(60_000);
  });
  it("the global limit keeps its own wait", () => {
    expect(discordWaitMs(H({ "retry-after": "40", "x-ratelimit-scope": "global" }), { retry_after: 40, global: true })).toEqual({ ms: 40_000, global: true });
  });

  it("transport: production headers → a short RateLimitedError; Cloudflare (HTML or 'error code: 1015') → cloudflare", async () => {
    const answers = [
      new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 0.3, global: false }), { status: 429, headers: prod }),
      new Response("error code: 1015", { status: 429, headers: { "content-type": "text/plain; charset=UTF-8", "retry-after": "1800" } }),
      new Response("<!DOCTYPE html><title>Access denied</title>", { status: 429, headers: { "content-type": "text/html", "retry-after": "1800" } }),
    ];
    const t = new DiscordWebhookTransport({ fetch: async () => answers.shift()! });
    const hook = { id: "1", url: "https://discord.com/api/webhooks/1/x" };
    const e1 = await t.getAttachments(hook, "5").catch((e) => e);
    expect(e1).toBeInstanceOf(RateLimitedError);
    expect([e1.retryAfterMs, e1.cloudflare, e1.scope]).toEqual([300, false, "user"]);
    for (let i = 0; i < 2; i++) {
      const e = await t.getAttachments(hook, "5").catch((x) => x);
      expect([e.cloudflare, e.retryAfterMs]).toEqual([true, 1_800_000]);
    }
    expect(isCloudflareBlock(new Response("error code: 1015", { status: 429, headers: { "content-type": "text/plain" } }))).toBe(true);
    expect(isCloudflareBlock(new Response("{}", { status: 429, headers: prod }))).toBe(false);
  });

  it("a download of many fragments over one webhook's bucket, 429s with the production headers: completes in seconds", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    const h = fake.addWebhook("chan-429");
    const t = new DiscordWebhookTransport({ apiOrigin: origin });
    const mk = () => new MetadataClient({ device: { id: "dev-429", name: "d" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [{ id: h.id, url: h.url }], chunkSize: 64 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), concurrency: 20 });
    const c = mk();
    const data = new Uint8Array(30 * 64 * 1024);
    for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
    const up = await c.upload(memorySource(data), "duzy.bin");
    // From now on GETs of messages answer like Discord's bucket: more than 5 a second → 429 (scope user,
    // body 0.3 s, header retry-after 1812).
    fake.getPerSecPerHook = 5;
    const parts: Uint8Array[] = [];
    const sink: ByteSink = { write: async (d) => void parts.push(new Uint8Array(d)) };
    const t0 = Date.now();
    await c.download(up.nodeId, sink);
    const took = Date.now() - t0;
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) (all.set(p, o), (o += p.byteLength));
    expect(await sha256Hex(all)).toBe(await sha256Hex(data));
    expect(took).toBeLessThan(30_000);
  }, 60_000);
});
