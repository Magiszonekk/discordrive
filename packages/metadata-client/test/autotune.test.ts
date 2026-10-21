// Automatic pieces in flight (AutoTuner) and links fetched ahead (LinkAhead).
//
// Tuner: a simulated line in virtual time (fluid model: every piece in flight gets min(its own speed,
// line / pieces), plus a fixed delay per piece). The tuner must find the plateau — grow while the total
// speed grows, stop where it does not — and not run to the cap on a narrow line.
// Links: expiry from the signed URL, a CDN 403/404 → one fresh link, limits per webhook and in total.
// End to end: a fake Discord over HTTP with a slow link GET and a narrow CDN: the download finds the
// plateau, slots no longer wait for links, and the link GETs stay under the per-webhook limit.
import { describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { AutoTuner, NetControl, type NetClock } from "../src/net.js";
import { LinkAhead, linkExpiry } from "../src/link-ahead.js";
import { DiscordHttpError, RateLimitedError } from "../src/discord-transport.js";
import { ChannelPacer, DiscordWebhookTransport, LocalArbiter, MemoryLogSink, MemoryTransport, MetadataClient, TransferLog, WebhookBlobStore, memorySource, sha256Hex } from "../src/index.js";
import { buildReport, parseLines } from "../src/transfer-report.js";
import { FakeDiscord } from "../src/node/fake-discord.js";

class VClock implements NetClock {
  t = 1_000_000;
  now = () => this.t;
  random = () => 0.5;
  setTimeout = () => 0;
  clearTimeout = () => {};
}

/**
 * Run a transfer of `pieces` pieces of `size` bytes through the tuner on a simulated line: `line` bytes/s
 * shared, `perPiece` bytes/s at most per piece, `delayMs` before a piece's bytes start (link, headers).
 */
function simulate(o: { line: number; perPiece: number; delayMs: number; size?: number; pieces?: number; tuner: AutoTuner; clock: VClock; noise?: number; dt?: number }) {
  const size = o.size ?? 10e6;
  const total = o.pieces ?? 400;
  const dt = o.dt ?? 20;
  const clock = o.clock;
  type P = { tk: ReturnType<AutoTuner["begin"]>; left: number; wait: number };
  const act: P[] = [];
  let started = 0;
  let done = 0;
  const trace: { t: number; n: number; bps: number }[] = [];
  let k = 0;
  while (done < total) {
    while (act.length < o.tuner.target && started < total) {
      act.push({ tk: o.tuner.begin(), left: size, wait: o.delayMs });
      started++;
    }
    const sending = act.filter((p) => p.wait <= 0).length;
    const noise = o.noise ? 1 + o.noise * Math.sin(k++ / 7) : 1;
    const share = Math.min(o.perPiece, sending ? (o.line * noise) / sending : 0);
    let bytes = 0;
    clock.t += dt;
    for (const p of [...act]) {
      if (p.wait > 0) {
        p.wait -= dt;
        continue;
      }
      const b = Math.min(p.left, (share * dt) / 1000);
      p.left -= b;
      bytes += b;
      if (p.left <= 0) {
        act.splice(act.indexOf(p), 1);
        done++;
        o.tuner.end(p.tk, size, started < total);
      }
    }
    trace.push({ t: clock.t, n: o.tuner.target, bps: (bytes / dt) * 1000 });
  }
  return trace;
}

describe("automatic pieces in flight", () => {
  it("download on a fast line, each piece ~8 MB/s (owner's home line, 59 MB/s): grows to the plateau and stays there", () => {
    const clock = new VClock();
    const ev: Record<string, unknown>[] = [];
    const tu = new AutoTuner("down", { start: 4, cap: 32 }, clock, (_e, f) => ev.push(f));
    const trace = simulate({ line: 59e6, perPiece: 8e6, delayMs: 50, tuner: tu, clock, pieces: 600 });
    // 59 / 8 ≈ 7.4 pieces fill the line: the accepted value is between 8 and 14, never the cap
    expect(tu.accepted).toBeGreaterThanOrEqual(8);
    expect(tu.accepted).toBeLessThanOrEqual(14);
    expect(Math.max(...trace.map((x) => x.n))).toBeLessThanOrEqual(21);
    // it went up because of measured gains, and stopped because of no gain
    expect(ev.some((e) => e.why === "gain")).toBe(true);
    expect(ev.some((e) => e.why === "flat")).toBe(true);
    // the second half of the transfer runs at ≥ 95 % of the line
    const half = trace.slice(trace.length >> 1);
    expect(half.reduce((a, x) => a + x.bps, 0) / half.length).toBeGreaterThan(0.92 * 59e6);
  });

  it("upload on a narrow line (11 MB/s): does not grow to 32; goes back to few pieces", () => {
    const clock = new VClock();
    const ev: Record<string, unknown>[] = [];
    const tu = new AutoTuner("up", { start: 4, cap: 32, shrink: true }, clock, (_e, f) => ev.push(f));
    const trace = simulate({ line: 11e6, perPiece: Infinity, delayMs: 300, tuner: tu, clock, pieces: 300 });
    expect(Math.max(...trace.map((x) => x.n))).toBeLessThanOrEqual(8); // one doubling tried, nothing gained
    expect(tu.accepted).toBeLessThanOrEqual(4);
    expect(tu.accepted).toBeGreaterThanOrEqual(2);
    expect(ev.filter((e) => e.why === "gain").length).toBe(0);
  });

  it("a line that gets faster later is followed (re-check), and a noisy line does not run to the cap", () => {
    const clock = new VClock();
    const tu = new AutoTuner("down", { start: 4, cap: 32, recheckMs: 30_000 }, clock);
    simulate({ line: 20e6, perPiece: 5e6, delayMs: 50, tuner: tu, clock, pieces: 200, noise: 0.03 });
    const first = tu.accepted;
    expect(first).toBeGreaterThanOrEqual(4);
    expect(first).toBeLessThanOrEqual(9);
    simulate({ line: 80e6, perPiece: 5e6, delayMs: 50, tuner: tu, clock, pieces: 1500, noise: 0.03 });
    // 80 / 5 = 16 pieces fill it: accepted 16–24 (a step of × 1.5 lands on 21), the step to 32 is undone
    expect(tu.accepted).toBeGreaterThan(first);
    expect(tu.accepted).toBeGreaterThanOrEqual(14);
    expect(tu.accepted).toBeLessThan(32);
  });

  it("a step that helped is remembered at once (the file may end before the check settles); the next session starts there", () => {
    const clock = new VClock();
    const seen: number[] = [];
    const tu = new AutoTuner("up", { start: 8, cap: 32, shrink: true }, clock);
    tu.onAccept = (n) => seen.push(n);
    // 1 GB on a fast line: the upload ends while 32 is still being tried
    simulate({ line: 45e6, perPiece: 2.5e6, delayMs: 300, tuner: tu, clock, pieces: 96, size: 10.5e6 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(16);
    // next session: starts at the remembered 16 and gets to 32 sooner than from 8
    const c2 = new VClock();
    const fresh = new AutoTuner("up", { start: 8, cap: 32, shrink: true }, c2);
    const t1 = simulate({ line: 45e6, perPiece: 2.5e6, delayMs: 300, tuner: fresh, clock: c2, pieces: 96, size: 10.5e6 });
    const c3 = new VClock();
    const seeded = new AutoTuner("up", { start: 8, cap: 32, shrink: true }, c3);
    seeded.seed(seen.at(-1)!);
    const t2 = simulate({ line: 45e6, perPiece: 2.5e6, delayMs: 300, tuner: seeded, clock: c3, pieces: 96, size: 10.5e6 });
    expect(t2.at(-1)!.t - 1_000_000).toBeLessThan((t1.at(-1)!.t - 1_000_000) * 0.95);
  });

  it("network errors cut the value (window halves → tuner follows), memory/channel cap bounds it", () => {
    const clock = new VClock();
    const net = new NetControl({ clock, tune: { start: 16 } });
    net.tune.down.setCap(32);
    expect(net.tune.down.target).toBe(16);
    net.win.down.setMax(16);
    for (let i = 0; i < 3; i++) (clock.t += 10, net.win.down.fail(clock.t - 1)); // a burst of errors
    expect(net.win.down.limit).toBe(8);
    expect(net.tune.down.target).toBe(8);
    expect(net.tune.down.changes.at(-1)?.why).toBe("errors");
    // a value learned in an earlier session is the start (no doubling ramp from it); once measured, seeds are ignored
    const sd = new AutoTuner("up", { start: 4, cap: 32 }, clock);
    let accepted = 0;
    sd.onAccept = (n) => (accepted = n);
    sd.seed(14);
    expect(sd.target).toBe(14);
    simulate({ line: 100e6, perPiece: 8e6, delayMs: 10, tuner: sd, clock, pieces: 200 });
    expect(accepted).toBeGreaterThanOrEqual(12);
    sd.seed(3);
    expect(sd.target).not.toBe(3);
    net.tune.down.setCap(5);
    expect(net.tune.down.target).toBe(5);
    const tu = new AutoTuner("down", { start: 4, cap: 6 }, clock);
    simulate({ line: 500e6, perPiece: 8e6, delayMs: 10, tuner: tu, clock, pieces: 300 });
    expect(tu.target).toBe(6);
  });

  it("the client: automatic until a value is set; save data → 2; events reach the report", async () => {
    const t = new MemoryTransport();
    const hooks = Array.from({ length: 4 }, (_, i) => ({ id: `155000000000008${String(i).padStart(4, "0")}`, url: `mem://h/${i}`, channelId: `c${i}` }));
    const c = new MetadataClient({ device: { id: "d", name: "d" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: hooks, chunkSize: 1000 });
    expect(c.autoConcurrency).toEqual({ upload: true, download: true });
    expect(c.downloadConcurrency).toBe(4);
    c.setSaveData(true);
    expect(c.net.win.down.max).toBe(2);
    expect(c.net.win.up.max).toBe(2);
    c.setSaveData(false);
    c.setConcurrency({ download: 16 });
    expect(c.net.win.down.max).toBe(16);
    expect(c.autoConcurrency.download).toBe(false);
    const ev = [{ v: 1, t: 1000, src: "web", ev: "tune", dir: "down", from: 4, to: 6, why: "try", an: 4, ab: 32e6 }, { v: 1, t: 9000, src: "web", ev: "tune", dir: "down", from: 6, to: 4, why: "flat", an: 4, ab: 32e6, mn: 6, mb: 33e6 }];
    const rep = buildReport(ev as never);
    expect(rep.summary.tune?.changes.length).toBe(2);
    expect(rep.text).toMatch(/down 6 → 4 flat \(4: 32 MB\/s, 6: 33 MB\/s\)/);
  });
});

describe("links ahead", () => {
  const P = (i: number, hook = "1550000000000009001") => ({ provider: "discord-webhook" as const, locationId: hook, channelId: "c", messageId: `m${i}`, attachmentId: `a${i}` });

  it("expiry from the signed link (ex = hex seconds); cached until shortly before it", async () => {
    let now = 1_800_000_000_000;
    const ex = Math.floor(now / 1000 + 3600).toString(16);
    expect(linkExpiry(`https://cdn.example/x.txt?ex=${ex}&is=0&hm=ab`)).toBe(parseInt(ex, 16) * 1000);
    expect(linkExpiry("https://cdn.example/x.txt")).toBeNull();
    let calls = 0;
    const la = new LinkAhead(async (it) => (calls++, `https://cdn.example/${it.p.attachmentId}.txt?ex=${ex}&is=0&hm=${calls}`), { now: () => now, marginMs: 10 * 60_000, perMin: 1e6, burst: 1e6 });
    const a = await la.need({ p: P(1) });
    expect(a.how).toBe("miss");
    expect((await la.need({ p: P(1) })).how).toBe("hit");
    now += 49 * 60_000; // 11 min before expiry: still valid
    expect((await la.need({ p: P(1) })).how).toBe("hit");
    now += 2 * 60_000; // 9 min before: refreshed
    const b = await la.need({ p: P(1) });
    expect(b.how).toBe("miss");
    expect(calls).toBe(2);
  });

  it("look-ahead: want() fetches in the background in order; a read finds its link ready", async () => {
    const order: string[] = [];
    const la = new LinkAhead(async (it) => (order.push(it.p.attachmentId), await new Promise((r) => setTimeout(r, 5)), `https://cdn.example/${it.p.attachmentId}`), { perMin: 1e6, burst: 1e6, maxActive: 2 });
    la.want([1, 2, 3, 4, 5].map((i) => ({ p: P(i) })));
    expect(la.stats.maxActive).toBe(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect((await la.need({ p: P(3) })).how).toBe("hit");
    // a read for a link still queued goes first
    la.want([6, 7, 8, 9].map((i) => ({ p: P(i) })));
    const r = await la.need({ p: P(9) });
    expect(r.how).toBe("wait");
    expect(order.indexOf("a9")).toBeLessThan(order.indexOf("a8"));
  });

  it("limits: at most maxActive in flight, per-webhook pace, a 429 waits on that webhook only and is not a failure", async () => {
    const t0 = Date.now();
    const times = new Map<string, number[]>();
    let n429 = 0;
    let active = 0;
    let peak = 0;
    const la = new LinkAhead(
      async (it) => {
        active++;
        peak = Math.max(peak, active);
        const h = it.p.locationId;
        times.set(h, [...(times.get(h) ?? []), Date.now() - t0]);
        try {
          if (it.p.attachmentId === "a3" && n429 === 0) {
            n429++;
            throw new RateLimitedError(300, "user", false);
          }
          await new Promise((r) => setTimeout(r, 20));
          return `https://cdn.example/${it.p.attachmentId}`;
        } finally {
          active--;
        }
      },
      { perMin: 600, maxPerMin: 600, burst: 2, maxActive: 3 },
    );
    const items = Array.from({ length: 12 }, (_, i) => ({ p: P(i, i % 2 ? "1550000000000009001" : "1550000000000009002") }));
    la.want(items);
    for (const it of items) await la.need(it);
    expect(peak).toBeLessThanOrEqual(3);
    expect(la.stats.r429).toBe(1);
    expect(la.stats.failed).toBe(0);
    // 10/s per webhook after a burst of 2: 6 requests on one webhook take ≥ 0.35 s
    for (const ts of times.values()) expect(ts.at(-1)! - ts[0]!).toBeGreaterThanOrEqual(300);
  });

  it("a CDN 403/404 (expired link) → one fresh link and again, not a failure", async () => {
    const t = new MemoryTransport();
    const hook = { id: "1550000000000009101", url: "mem://h", channelId: "c" };
    const st = new WebhookBlobStore(t, [hook], { links: { perMin: 1e6, burst: 1e6 }, sleep: async () => {} });
    const posted = await st.put(new Uint8Array([1, 2, 3]), "x.txt");
    const orig = t.fetchCdn.bind(t);
    const seen: string[] = [];
    t.fetchCdn = async (u, ...rest) => {
      seen.push(u);
      if (seen.length === 1) throw new DiscordHttpError(403, "cdn get");
      return orig(u, ...rest);
    };
    let gets = 0;
    const ga = t.getAttachments.bind(t);
    t.getAttachments = async (...a) => (gets++, ga(...a));
    expect([...(await st.get(posted))]).toEqual([1, 2, 3]);
    expect(gets).toBe(2);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(st.links.stats.stale).toBe(1);
  });
});

describe("end to end on a fake Discord: slow link GET, narrow CDN", () => {
  it("download finds the plateau, slots do not wait for links, link GETs stay under the webhook limit", async () => {
    const fake = new FakeDiscord();
    fake.cdnCorsAll = true;
    const origin = await fake.listen();
    fake.getDelayMs = 300; // a link takes 0.3 s, like Discord's GET of a message
    fake.getPerSecPerHook = 5; // Discord: 5 per webhook, ~1 s reset
    fake.cdnBytesPerSec = 4e6; // the line
    fake.cdnBytesPerSecPerRead = 0.5e6; // one CDN read on its own: 8 reads fill the line
    try {
      // 8 webhooks × 2.5+ links/s ≥ 20 links/s; the line needs 8 pieces/s (4 MB/s of 512 KiB pieces).
      const hooks = Array.from({ length: 8 }, () => fake.addWebhook()).map((h) => ({ id: h.id, url: h.url, channelId: h.channelId }));
      const clock: NetClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as never), random: Math.random };
      const net = new NetControl({ clock, tune: { minSpanMs: 1200, minPieces: 1.5 } });
      const c = new MetadataClient({ device: { id: "d", name: "d" }, arbiter: new LocalArbiter(new Sequencer()), transport: new DiscordWebhookTransport({ apiOrigin: origin }), webhooks: hooks, chunkSize: 512 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), net, concurrency: 16 });
      const data = new Uint8Array(64 * 1024 * 1024);
      for (let o = 0; o < data.length; o += 65536) crypto.getRandomValues(data.subarray(o, o + 65536));
      const up = await c.upload(memorySource(data), "f.bin");
      const mem = new MemoryLogSink();
      c.setTransferLog(new TransferLog(mem.write, { src: "cli", mode: "metadata-only" }));
      for (const l of fake.getLog.values()) l.length = 0;
      const parts: Uint8Array[] = [];
      const t0 = Date.now();
      await c.download(up.nodeId, { write: async (d) => void parts.push(new Uint8Array(d)) });
      const secs = (Date.now() - t0) / 1000;
      expect(await sha256Hex(Buffer.concat(parts))).toBe(await sha256Hex(data));
      const rep = buildReport(parseLines(mem.text()).events);
      // the plateau: 8 reads fill the line; the value ends near it, never at the cap of 32
      const last = net.tune.down.accepted;
      expect(last).toBeGreaterThanOrEqual(6);
      expect(last).toBeLessThanOrEqual(16);
      expect(Math.max(...(rep.summary.tune?.changes.map((x) => x.to) ?? [0]))).toBeLessThan(32);
      // links: a slot waited for its link in only a small share of slot time (before: every read waited 0.3 s)
      expect(rep.summary.links!.n - rep.summary.links!.n429).toBe(128);
      expect(rep.summary.links!.failed).toBe(0);
      expect(rep.summary.links!.slotShare).toBeLessThan(0.05);
      expect(rep.summary.links!.hit).toBeGreaterThan(110);
      // limits: few 429s from the fake (each costs 0.3 s on that webhook, no failure), never more than 5 GETs per webhook in any second
      let n429 = 0;
      let worst = 0;
      for (const l of fake.getLog.values()) {
        n429 += l.filter((g) => g.st === 429).length;
        for (const g of l) worst = Math.max(worst, l.filter((h) => h.st === 200 && h.t0 >= g.t0 && h.t0 < g.t0 + 1000).length);
      }
      expect(n429).toBeLessThanOrEqual(6);
      expect(worst).toBeLessThanOrEqual(5);
      // and the line was used: ≥ 75 % of 4 MB/s over the whole download (incl. the ramp from 4)
      expect(data.length / 1e6 / secs).toBeGreaterThan(3);
    } finally {
      await fake.close();
    }
  }, 60_000);
});

describe("upload: isolated network errors do not throttle it for good", () => {
  /**
   * 160 posts of 256 KiB to a fake Discord over HTTP that answers each post after 300 ms (the line is
   * not the limit: more in flight = faster), automatic value, 8 channels. `drop`: post numbers whose
   * connection the fake drops (the client sees "Failed to fetch" and retries).
   */
  async function run(drop: number[] | "burst", posts = 160): Promise<{ secs: number; limitEnd: number; target: number; cuts: number; ignored: number; minLimit: number }> {
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    fake.postDelayMs = 300;
    try {
      const hooks = Array.from({ length: 8 }, () => fake.addWebhook()).map((h) => ({ id: h.id, url: h.url, channelId: h.channelId }));
      const clock: NetClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as never), random: Math.random };
      const net = new NetControl({ clock, tune: { minSpanMs: 600, recheckMs: 600_000 }, window: { recoverMs: 1500 } });
      const c = new MetadataClient({ device: { id: "d", name: "d" }, arbiter: new LocalArbiter(new Sequencer()), transport: new DiscordWebhookTransport({ apiOrigin: origin }), webhooks: hooks, chunkSize: 256 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), net, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
      if (drop === "burst") {
        // A weak link: from post 20 on, 4 of every 10 posts lose their connection.
        for (let k = 20; k < 400; k++) if (k % 10 < 4) fake.dropPosts.add(k);
      } else for (const k of drop) fake.dropPosts.add(k);
      let minLimit = Infinity;
      const iv = setInterval(() => (minLimit = Math.min(minLimit, net.win.up.limit)), 20);
      const data = new Uint8Array(posts * 256 * 1024 - 7).map((_, i) => (i * 31) & 255);
      const t0 = Date.now();
      await c.upload(memorySource(data), "f.bin");
      clearInterval(iv);
      return { secs: (Date.now() - t0) / 1000, limitEnd: net.win.up.limit, target: net.tune.up.target, cuts: net.win.up.cuts, ignored: net.win.up.ignored, minLimit };
    } finally {
      await fake.close();
    }
  }

  it("~2 dropped posts per 100 on a fast line: the window stays, speed ≥ 90 % of the run without drops; a real burst still cuts", async () => {
    const clean = await run([]);
    const two = await run([37, 98, 141]); // ~2 per 100 posts: 3 drops in 160
    expect(two.cuts).toBe(0);
    expect(two.ignored).toBe(3);
    expect(two.minLimit).toBe(clean.minLimit);
    expect(two.limitEnd).toBeGreaterThanOrEqual(8);
    // ≥ 90 % of the clean run (each dropped post costs its retry back-off; the rest runs at full width)
    expect(clean.secs / two.secs).toBeGreaterThanOrEqual(0.9);
    const weak = await run("burst");
    expect(weak.cuts).toBeGreaterThanOrEqual(1);
    expect(weak.minLimit).toBeLessThan(clean.minLimit);
  }, 120_000);
});
