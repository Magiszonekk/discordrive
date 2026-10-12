// Server sender against the fake Discord over HTTP: per-channel 429s, rotation, Cloudflare
// fail-fast, dead webhooks, egress budget, and the encrypted webhook table.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport } from "@ddv4/metadata-client";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { DiscordSender, DiscordUnavailableError, InstanceHooks, NoChannelError, POOL, loadInstanceKey, type SenderHook } from "../src/index.js";

let fake: FakeDiscord;
afterEach(async () => fake?.close());

async function setup(channels: string[], o: { perMin?: number; burst?: number } = {}) {
  fake = new FakeDiscord();
  const origin = await fake.listen();
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const hooks: SenderHook[] = channels.map((c) => {
    const h = fake.addWebhook(c);
    return { id: h.id, url: h.url, channelId: c };
  });
  // Fast pacer for tests (real default 30/min): the SHAPE of the behaviour is what is checked.
  const pacer = new ChannelPacer({ perMin: o.perMin ?? 600, maxPerMin: o.perMin ?? 600, minPerMin: 60, burst: o.burst ?? 2 });
  const sender = new DiscordSender({ transport, pacer, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  return { origin, transport, hooks, sender };
}

describe("DiscordSender", () => {
  it("spreads blobs over channels (the limit is per channel) and posts what it was given", async () => {
    const { hooks, sender } = await setup(["1550000000000000001", "1550000000000000002", "1550000000000000003"]);
    const data = new TextEncoder().encode("ciphertext");
    const placed = await Promise.all(Array.from({ length: 30 }, (_, i) => sender.post(hooks, data, `b${i}.txt`)));
    const per = [...fake.postsByChannel.values()];
    expect(per.length).toBe(3);
    expect(Math.min(...per)).toBeGreaterThanOrEqual(8); // ~10 each, no channel starved
    expect(new TextDecoder().decode(fake.attachmentData(placed[0]!.attachmentId))).toBe("ciphertext");
    expect(placed[0]!.channelId).toMatch(/^155/);
  });

  it("429 shared on one channel: the pacer slows that channel, the posts still all land", async () => {
    const { hooks, sender } = await setup(["1550000000000000011", "1550000000000000012"], { perMin: 600 });
    fake.perChannelPerMin = 8; // fake: 8 per minute per channel, then 429 shared
    const data = new Uint8Array(100);
    const t0 = Date.now();
    // 16 fit in the fake's window over 2 channels; more would wait a minute: stop at 16.
    await Promise.all(Array.from({ length: 16 }, (_, i) => sender.post(hooks, data, `x${i}.txt`)));
    expect(fake.posts).toBe(16);
    expect([...fake.postsByChannel.values()]).toEqual([8, 8]);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("429 shared is reported per channel and lowers only that channel's rate", async () => {
    const { hooks, sender } = await setup(["1550000000000000021", "1550000000000000022"], { perMin: 600 });
    fake.perChannelPerMin = 3;
    const data = new Uint8Array(10);
    const run = Promise.all(Array.from({ length: 7 }, (_, i) => sender.post(hooks, data, `y${i}.txt`).catch((e) => e)));
    // 6 land at once (3 per channel); the 7th meets 429 shared on both and waits ~60 s in the fake: give up on it.
    const t0 = Date.now();
    while (sender.stats.shared429 === 0 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(sender.stats.shared429).toBeGreaterThan(0);
    expect(fake.rejectedByChannel.size).toBeGreaterThan(0);
    const slowed = [...fake.rejectedByChannel.keys()].map((c) => sender.pacer.rate(c));
    expect(Math.max(...slowed)).toBeLessThan(600);
    fake.perChannelPerMin = 0;
    // the fake keeps its window; clear it by allowing posts again
    await run;
    expect(fake.posts).toBeGreaterThanOrEqual(6);
  });

  it("Cloudflare block (HTML 429, no x-ratelimit headers): fails at once with retry-after, then refuses locally without asking Discord", async () => {
    const { hooks, sender } = await setup(["1550000000000000031"]);
    fake.cloudflareUntil = Date.now() + 2011_000;
    const t0 = Date.now();
    const e = await sender.post(hooks, new Uint8Array(5), "a.txt").catch((x) => x);
    expect(e).toBeInstanceOf(DiscordUnavailableError);
    expect((e as DiscordUnavailableError).cloudflare).toBe(true);
    expect((e as DiscordUnavailableError).retryAfterMs).toBeGreaterThan(2000_000);
    expect(Date.now() - t0).toBeLessThan(3000); // no sleeping out the clock inside the request
    const before = fake.webhookRequests;
    const e2 = await sender.post(hooks, new Uint8Array(5), "b.txt").catch((x) => x);
    expect(e2).toBeInstanceOf(DiscordUnavailableError);
    expect(fake.webhookRequests).toBe(before); // refused locally
    expect(sender.cloudflareBlockMs()).toBeGreaterThan(2000_000);
  });

  it("a deleted webhook is skipped (dead), the others take over; none left = need_channel", async () => {
    const { hooks, sender } = await setup(["1550000000000000041", "1550000000000000042"]);
    fake.deleteWebhook(hooks[0]!.id);
    for (let i = 0; i < 4; i++) await sender.post(hooks, new Uint8Array(3), `d${i}.txt`);
    expect(hooks[0]!.alive).toBe(false);
    expect(fake.postsByChannel.get("1550000000000000042")).toBe(4);
    expect(await sender.check(hooks[1]!)).toBe("alive");
    fake.deleteWebhook(hooks[1]!.id);
    expect(await sender.check(hooks[1]!)).toBe("dead");
    await expect(sender.post(hooks, new Uint8Array(3), "z.txt")).rejects.toBeInstanceOf(NoChannelError);
  });

  it("proactive egress budget: past the ceiling requests are refused before reaching Discord", async () => {
    fake = new FakeDiscord();
    const origin = await fake.listen();
    const h = fake.addWebhook("1550000000000000051");
    const sender = new DiscordSender({ transport: new DiscordWebhookTransport({ apiOrigin: origin }), pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 50 }), egressBudget: 6, sleep: async () => {} });
    const hooks = [{ id: h.id, url: h.url, channelId: h.channelId }];
    for (let i = 0; i < 6; i++) await sender.post(hooks, new Uint8Array(1), `e${i}.txt`);
    const e = await sender.post(hooks, new Uint8Array(1), "e7.txt").catch((x) => x);
    expect(e).toBeInstanceOf(DiscordUnavailableError);
    expect(fake.posts).toBe(6);
    expect(sender.stats.refusedBudget).toBe(1);
  });

  it("cancel: an aborted post stops and nothing more is sent", async () => {
    const { hooks, sender } = await setup(["1550000000000000061"]);
    const ac = new AbortController();
    ac.abort();
    await expect(sender.post(hooks, new Uint8Array(1), "c.txt", ac.signal)).rejects.toThrow();
    expect(fake.posts).toBe(0);
  });
});

describe("InstanceHooks (webhooks encrypted with the instance key)", () => {
  it("stores sealed URLs, never in clear; pool vs account channels; wrong key refuses", async () => {
    const { transport } = await setup([]);
    const dir = mkdtempSync(join(tmpdir(), "ddn-hooks-"));
    const keyPath = join(dir, "instance.key");
    const key = loadInstanceKey(keyPath);
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(loadInstanceKey(keyPath).equals(key)).toBe(true);
    const db = new DatabaseSync(join(dir, "ddn.db"));
    const store = new InstanceHooks(db, key);
    const p1 = fake.addWebhook("1550000000000000071");
    const p2 = fake.addWebhook("1550000000000000072");
    const own = fake.addWebhook("1550000000000000073");
    await store.add(POOL, p1.url, transport);
    await store.add(POOL, p2.url, transport);
    expect(store.hooksFor("acct-a").map((h) => h.channelId).sort()).toEqual(["1550000000000000071", "1550000000000000072"]);
    await store.add("acct-a", own.url, transport, "mine");
    expect(store.hooksFor("acct-a").map((h) => h.channelId)).toEqual(["1550000000000000073"]);
    expect(store.hooksFor("acct-b").length).toBe(2);
    expect(store.list("acct-a")[0]).toMatchObject({ channelId: "1550000000000000073", label: "mine", alive: true });
    expect(JSON.stringify(store.list("acct-a"))).not.toContain("/webhooks/");
    // The database file has no URL token in clear.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(join(dir, "ddn.db")).toString("latin1");
    for (const u of [p1.url, own.url]) expect(raw).not.toContain(u.split("/").pop()!);
    // The same webhook cannot be claimed by another account.
    await expect(store.add("acct-b", own.url, transport)).rejects.toThrow(/webhook_in_use/);
    expect(store.remove("acct-a", own.id)).toBe(true);
    expect(store.hooksFor("acct-a").length).toBe(2);
    // A replaced instance key cannot open the table.
    expect(() => new InstanceHooks(db, Buffer.alloc(32, 7))).toThrow(/instance key/);
    db.close();
  });
});
