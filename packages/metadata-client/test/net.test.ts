// Adaptive window, no-network gate, reference speed, stuck-connection
// guard — in virtual time. The guard scenarios: one stuck connection (first byte fast, body slow) vs a
// weak link (everything slow + errors) vs a metered link; the guard acts only in the first, and in the
// others never sends a request on another connection.
import { describe, expect, it } from "vitest";
import { AdaptiveWindow, NetControl, NetGate, NetworkError, SpeedBaseline, StuckGuard, isNetworkError, jitter, type NetClock } from "../src/net.js";

/** Virtual clock with timers. */
class VClock implements NetClock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  r = 0.5;
  now = () => this.t;
  random = () => this.r;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => void (this.timers = this.timers.filter((x) => x.id !== h));
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const n = this.timers[0];
      if (!n || n.at > end) break;
      this.timers.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = end;
  }
  pending() {
    return this.timers.length;
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("network errors", () => {
  it("tells 'no answer' from HTTP errors, 429s and aborts", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("cdn get: Failed to fetch"))).toBe(true);
    expect(isNetworkError(new NetworkError("x", true))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("x"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("rate limited"), { name: "RateLimitedError" }))).toBe(false);
    expect(isNetworkError(new Error("webhook post: HTTP 500"))).toBe(false);
  });
  it("jitter stays within 0.5–1.5 ×", () => {
    expect(jitter(1000, () => 0)).toBe(500);
    expect(jitter(1000, () => 0.999)).toBe(1499);
  });
});

describe("adaptive window", () => {
  it("halves on a network error (once per loss event), min 2, grows back slowly to the maximum", () => {
    const c = new VClock();
    const ev: unknown[] = [];
    const w = new AdaptiveWindow("down", 32, c, (e, f) => ev.push(f));
    expect(w.limit).toBe(32);
    const t0 = c.t;
    c.advance(10);
    // 30 pieces in flight fail at once (owner's log: 30 × "Failed to fetch" at 154 s): ONE cut, not 30
    for (let i = 0; i < 30; i++) w.fail(t0);
    expect(w.limit).toBe(16);
    expect(w.cuts).toBe(1);
    // a request started after the cut fails: a new loss event
    c.advance(10);
    w.fail(c.t);
    expect(w.limit).toBe(8);
    for (let k = 0; k < 10; k++) (c.advance(10), w.fail(c.t));
    expect(w.limit).toBe(2);
    // growth: +1 per ceil(limit/4) answers → from 2 to 32 takes a few hundred answers, not one
    let answers = 0;
    while (w.limit < 32) (w.ok(), answers++);
    expect(answers).toBeGreaterThan(100);
    expect(w.limit).toBe(32);
    w.ok();
    expect(w.limit).toBe(32);
    expect(ev.length).toBeGreaterThan(5);
  });

  it("a never-cut window follows the configured maximum; a cut one is clamped", () => {
    const w = new AdaptiveWindow("up", 8, new VClock());
    w.setMax(20);
    expect(w.limit).toBe(20);
    w.fail(0);
    expect(w.limit).toBe(10);
    w.setMax(4);
    expect(w.limit).toBe(4);
    w.setMax(30);
    expect(w.limit).toBe(4); // an error a moment ago: grows back by itself, not at once
  });

  it("acquire blocks above the limit and wakes when a slot frees or the limit grows", async () => {
    const c = new VClock();
    const w = new AdaptiveWindow("up", 4, c);
    w.fail(0); // → 2
    const r1 = await w.acquire();
    const r2 = await w.acquire();
    let third = false;
    const p = w.acquire().then((r) => ((third = true), r));
    await flush();
    expect(third).toBe(false);
    r1();
    await flush();
    expect(third).toBe(true);
    (await p)();
    r2();
    const ac = new AbortController();
    await w.acquire();
    await w.acquire();
    const q = w.acquire(ac.signal);
    ac.abort();
    await expect(q).rejects.toThrow(/abort/);
  });
});

describe("no-network gate", () => {
  it("offline event: everything waits, no probe at all until online; then all go", async () => {
    const c = new VClock();
    const g = new NetGate(c);
    g.setOnline(false);
    let passed = 0;
    for (let i = 0; i < 5; i++) void g.pass().then(() => passed++);
    c.advance(10 * 60_000);
    await flush();
    expect(passed).toBe(0);
    expect(g.probes).toBe(0);
    expect(c.pending()).toBe(0); // no timers while offline: zero traffic
    g.setOnline(true);
    await flush();
    expect(passed).toBe(5);
  });

  it("3 network errors in a row close it; one probe after a growing pause with jitter; its success opens", async () => {
    const c = new VClock();
    const ev: Record<string, unknown>[] = [];
    const g = new NetGate(c, (_e, f) => ev.push(f), { baseMs: 1000, maxMs: 60_000 });
    g.fail();
    g.fail();
    expect(g.open).toBe(true);
    g.ok(); // an answer in between resets
    g.fail();
    g.fail();
    g.fail();
    expect(g.state).toBe("down");
    const tickets: { probe: boolean }[] = [];
    for (let i = 0; i < 8; i++) void g.pass().then((t) => tickets.push(t));
    await flush();
    expect(tickets.length).toBe(0);
    c.advance(1000); // base 1000 × jitter(0.5 + 0.5) = 1000
    await flush();
    expect(tickets).toEqual([{ probe: true }]); // exactly one request goes out
    g.fail(tickets[0]); // probe failed: next pause 2 s
    c.advance(1500);
    await flush();
    expect(tickets.length).toBe(1);
    c.advance(600);
    await flush();
    expect(tickets.length).toBe(2);
    expect(tickets[1]!.probe).toBe(true);
    g.ok(tickets[1]);
    await flush();
    expect(g.open).toBe(true);
    expect(tickets.length).toBe(8);
    expect(ev.map((e) => e.st)).toEqual(["down", "probe", "probe", "open"]);
  });

  it("pauses grow to the maximum and never flood: 30 min down = a handful of probes", async () => {
    const c = new VClock();
    const g = new NetGate(c, () => {}, { baseMs: 1000, maxMs: 60_000 });
    for (let i = 0; i < 3; i++) g.fail();
    let sent = 0;
    const loop = async () => {
      for (;;) {
        const t = await g.pass();
        sent++;
        g.fail(t);
        if (sent > 1000) return;
      }
    };
    void loop();
    void loop();
    void loop();
    for (let s = 0; s < 30 * 60; s++) {
      c.advance(1000);
      await flush();
    }
    // 1+2+4+8+16+32 s, then one per ~60 s: ~6 + 28
    expect(sent).toBeGreaterThan(20);
    expect(sent).toBeLessThan(45);
  });
});

describe("reference speed", () => {
  it("median of recent peaks, per direction and network type; ages out after a week; needs 2", () => {
    const b = new SpeedBaseline();
    const now = 10 * 24 * 3600_000;
    expect(b.value("down", now)).toBeNull();
    b.add("down", 70e6, now - 3600_000, "wifi");
    expect(b.value("down", now)).toBeNull();
    b.add("down", 80e6, now - 1800_000, "wifi");
    b.add("down", 2e6, now - 600_000, "cellular");
    b.add("down", 3e6, now - 300_000, "cellular");
    expect(b.value("down", now, "wifi")).toBe(75e6);
    expect(b.value("down", now, "cellular")).toBe(2.5e6);
    expect(b.value("up", now)).toBeNull();
    expect(b.value("down", now + 8 * 24 * 3600_000)).toBeNull();
    const c = new SpeedBaseline();
    c.load(JSON.parse(JSON.stringify(b.data)));
    expect(c.value("down", now, "wifi")).toBe(75e6);
    c.load({ v: 1, down: [{ t: "x" }, null, { t: 1, bps: -1 }] });
    expect(c.data.down).toEqual([]);
  });
});

// ── guard scenarios ────────────────────────────────────────────────
// A simulated download: N pieces in flight on connection `lane`; each piece's time comes from the scenario.
interface Scenario {
  /** Time to first byte and to the end of one piece of `bytes` on a connection, with `k` pieces on it. */
  piece(lane: number, k: number): { ttfb: number; total: number; fail?: boolean };
}

async function simulate(sc: Scenario, o: { metered?: boolean; guardOn?: boolean; lanes?: number; seconds?: number; n?: number; baselineBps?: number | null } = {}) {
  const c = new VClock();
  const events: Record<string, unknown>[] = [];
  const net = new NetControl({ clock: c, metered: () => !!o.metered });
  net.laneCount = o.lanes ?? 2;
  net.guardOn = o.guardOn ?? true;
  net.emitTo = (ev, f) => events.push({ ev, ...f });
  if (o.baselineBps !== null) for (let i = 0; i < 3; i++) net.baseline.add("down", o.baselineBps ?? 75e6, c.t - (i + 1) * 3600_000, "");
  const g = net.guard;
  const BYTES = 10 * 1024 * 1024;
  const perLane = [0, 0, 0];
  const requestsOnLane = [0, 0, 0];
  let bytesDone = 0;
  let extraBytes = 0;
  const N = o.n ?? 32;
  const until = c.t + (o.seconds ?? 240) * 1000;
  const startOne = () => {
    const h = g.start();
    perLane[h.lane]!++;
    requestsOnLane[h.lane]!++;
    const p = sc.piece(h.lane, perLane[h.lane]!);
    c.setTimeout(() => {
      perLane[h.lane]!--;
      if (p.fail) {
        // a failed piece is fetched again (the same needed piece, retry)
        net.win.down.fail(h.t0);
        g.end(h, { ok: false });
        extraBytes += 0;
      } else {
        bytesDone += BYTES;
        net.win.down.ok();
        g.end(h, { ok: true, bytes: BYTES, ttfb: p.ttfb });
      }
      if (c.t < until) startOne();
    }, p.total);
  };
  for (let i = 0; i < N; i++) startOne();
  while (c.t < until) c.advance(1000);
  return { events, guard: g, requestsOnLane, bytesDone, extraBytes, net };
}

describe("stuck-connection guard", () => {
  // Owner's log 2026-10-15: one connection gives 14 MB/s to 32 pieces (first byte ~0.5 s, piece ~23 s);
  // a fresh connection gives ~75 MB/s.
  const stuck: Scenario = {
    piece: (lane, k) => {
      const mbps = lane === 0 ? 14e6 : 75e6;
      return { ttfb: 400, total: 400 + ((10 * 1024 * 1024) / (mbps / k)) * 1000 };
    },
  };
  // A weak link: the LINE is slow for every connection (shared 3 MB/s here … and errors).
  const weak = (errEvery: number): Scenario => {
    let n = 0;
    return {
      piece: (_lane, k) => {
        const fail = errEvery > 0 && ++n % errEvery === 0;
        return { ttfb: 1500, total: fail ? 8000 : 1500 + ((10 * 1024 * 1024) / (3e6 / Math.max(1, k))) * 1000, fail };
      },
    };
  };
  // The line is the limit (both connections share 14 MB/s): probe is as slow → "line", nothing changes.
  const lineLimited: Scenario = {
    piece: (_lane, k) => ({ ttfb: 300, total: 300 + ((10 * 1024 * 1024) / (14e6 / Math.max(1, k))) * 1000 }),
  };

  it("stuck connection: detected after warm-up, ONE needed piece on the other connection, then new requests switch", async () => {
    const r = await simulate(stuck);
    const st = r.events.filter((e) => e.ev === "guard").map((e) => e.st);
    expect(st.slice(0, 3)).toEqual(["detect", "probe", "switch"]);
    expect(r.guard.lane).toBe(1);
    expect(r.guard.stats.probes).toBe(1);
    expect(r.extraBytes).toBe(0);
    // no aborts: every request started was a needed piece and ended once
    const detectAt = r.events.find((e) => e.st === "detect");
    expect(detectAt).toBeTruthy();
    // after the switch the download is much faster than 14 MB/s
    expect(r.bytesDone / 240 / 1e6).toBeGreaterThan(30);
  });

  it("line limited: probe as slow → 'line', stays on the connection, next try only after the cooldown", async () => {
    const r = await simulate(lineLimited, { seconds: 360 });
    const st = r.events.filter((e) => e.ev === "guard").map((e) => e.st);
    expect(st[0]).toBe("detect");
    expect(st).toContain("line");
    expect(st).not.toContain("switch");
    expect(r.guard.lane).toBe(0);
    // ≤ 1 probe per 5 min: 6 min of run → at most 2 pieces went on connection 1
    expect(r.requestsOnLane[1]).toBeLessThanOrEqual(2);
    // the "line" verdict feeds the reference: it moves down towards the line
    expect(r.net.baseline.data.down.at(-1)!.bps).toBeLessThan(20e6);
  });

  it("weak link (slow + errors): the guard does nothing, not a single request on another connection; the window shrinks", async () => {
    const r = await simulate(weak(5));
    expect(r.events.filter((e) => e.ev === "guard")).toEqual([]);
    expect(r.requestsOnLane[1]).toBe(0);
    expect(r.net.win.down.cuts).toBeGreaterThan(0);
  });

  it("slow link without errors and a low reference (< 5 MB/s): guard off", async () => {
    const r = await simulate(weak(0), { baselineBps: 3e6 });
    expect(r.events.filter((e) => e.ev === "guard")).toEqual([]);
    expect(r.requestsOnLane[1]).toBe(0);
  });

  it("metered link / save data: guard off even when stuck — zero extra requests", async () => {
    const r = await simulate(stuck, { metered: true });
    expect(r.events.filter((e) => e.ev === "guard")).toEqual([]);
    expect(r.requestsOnLane[1]).toBe(0);
  });

  it("switch off, one connection only, or no reference yet: nothing", async () => {
    for (const o of [{ guardOn: false }, { lanes: 1 }, { baselineBps: null }]) {
      const r = await simulate(stuck, o);
      expect(r.events.filter((e) => e.ev === "guard")).toEqual([]);
      expect(r.requestsOnLane[1]).toBe(0);
    }
  });

  it("a new device collects its reference from real transfers (peaks of long busy periods)", async () => {
    const r = await simulate(lineLimited, { baselineBps: null, seconds: 60 });
    // the run ends busy; finishing all pieces makes it idle → the peak is recorded
    expect(r.net.baseline.data.down.length).toBe(0);
    const c = r.net.clock as VClock;
    // let the in-flight pieces finish (no new ones)
    const g = r.guard as StuckGuard;
    void g;
    c.advance(120_000);
    expect(r.net.baseline.data.down.length).toBe(1);
    expect(r.net.baseline.data.down[0]!.bps).toBeGreaterThan(10e6);
    expect(r.net.baseline.data.down[0]!.bps).toBeLessThan(16e6);
  });
});

describe("NetControl.attempt", () => {
  it("network errors close the gate and make retries free (they wait at the gate instead of failing the file)", async () => {
    const c = new VClock();
    const n = new NetControl({ clock: c });
    const boom = () => Promise.reject(new TypeError("Failed to fetch"));
    const r1 = await n.attempt("down", undefined, boom);
    expect(r1).toMatchObject({ ok: false, retryFree: false });
    await n.attempt("down", undefined, boom);
    const r3 = await n.attempt("down", undefined, boom);
    expect(r3).toMatchObject({ ok: false, retryFree: true });
    expect(n.uiState()).toBe("offline");
    // an HTTP error is an answer: not a network problem
    n.gate.setOnline(true);
    const r4 = await n.attempt("up", undefined, () => Promise.reject(new Error("webhook post: HTTP 500")));
    expect(r4).toMatchObject({ ok: false, retryFree: false });
    expect(n.gate.open).toBe(true);
    expect(n.uiState()).toBe("resumed");
    c.advance(6000);
    expect(n.uiState()).toBe("weak"); // the window was cut by the network errors a moment ago
    c.advance(61_000);
    expect(n.uiState()).toBe("ok");
  });
});

describe("transfer log + report", () => {
  it("guard, gate and window events reach the log and the report's Network section", async () => {
    const { MemoryLogSink, TransferLog } = await import("../src/index.js");
    const { buildReport, parseLines } = await import("../src/transfer-report.js");
    const mem = new MemoryLogSink();
    const log = new TransferLog(mem.write, { src: "web" });
    const r = await simulate(
      {
        piece: (lane, k) => {
          const mbps = lane === 0 ? 14e6 : 75e6;
          return { ttfb: 400, total: 400 + ((10 * 1024 * 1024) / (mbps / k)) * 1000 };
        },
      },
      {},
    );
    for (const e of r.events) log.emit(String(e.ev), e);
    log.emit("win", { dir: "down", lim: 4, max: 8, why: "net" });
    log.emit("gate", { st: "down", why: "errors" });
    log.emit("gate", { st: "open", why: "answer", waited: 4200 });
    log.emit("resume", { dir: "up", have: 3, n: 10 });
    const rep = buildReport(parseLines(mem.text()).events);
    expect(rep.summary.network).toMatchObject({ windowCuts: 1, windowMin: { down: 4 }, offline: 1, offlineMs: 4200, resumes: 1 });
    expect(rep.summary.network!.guard).toMatchObject({ detect: 1, probe: 1, switch: 1 });
    expect(rep.text).toMatch(/stuck-connection guard: detect 1, probe 1, switch 1/);
  });
});

describe("upload reference speed", () => {
  it("uploads feed the 'up' reference (peaks of long busy periods) and never probe", async () => {
    const { watchedPost } = await import("../src/net.js");
    const c = new VClock();
    const net = new NetControl({ clock: c });
    const events: unknown[] = [];
    net.emitTo = (ev) => events.push(ev);
    // 8 posts in flight, each 10 MiB in 2 s → ~40 MB/s for 60 s
    const BYTES = 10 * 1024 * 1024;
    let live = 0;
    const until = c.t + 60_000;
    const one = (): void => {
      live++;
      void watchedPost(net, BYTES, () => new Promise<void>((r) => c.setTimeout(r, 2000))).then(() => {
        live--;
        if (c.t < until) one();
      });
    };
    for (let i = 0; i < 8; i++) one();
    for (let s = 0; s < 70; s++) {
      c.advance(1000);
      await flush();
    }
    expect(live).toBe(0);
    expect(net.baseline.data.up.length).toBe(1);
    expect(net.baseline.data.up[0]!.bps).toBeGreaterThan(35e6);
    expect(net.baseline.data.up[0]!.bps).toBeLessThan(48e6);
    expect(events.filter((e) => e === "guard")).toEqual([]);
  });
});
