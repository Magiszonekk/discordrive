// Transfers on weak, unstable and "stuck" links (zlecenie 2026-10-15-transfery §2–3).
//
// Three different situations need opposite reactions, so they are told apart:
//
//   weak link        errors / timeouts / resets (mobile, bad Wi-Fi)   -> fewer pieces in flight (AdaptiveWindow)
//   no network       offline event or a burst of network errors        -> stop, wait, one probe at a time (NetGate)
//   stuck connection slow without any error, first byte fast, every    -> one NEEDED piece on another connection;
//                    piece slow (all share one narrow HTTP/2 / QUIC      only if it is clearly faster do new requests
//                    connection; owner's log 2026-10-15: 14 MB/s for     go there (StuckGuard). Never aborts anything.
//                    150 s, 57-77 MB/s after the connection dropped)
//
// No thresholds in MB/s: the guard compares with this device's own reference speed (SpeedBaseline, from
// real transfers), and stays off below ~5 MB/s, on metered links / "save data", without a reference, and
// while there are errors, 429s or no network. It never sends a byte more than the transfer needs: the probe
// is the next piece the download needs anyway, sent on the other connection.
//
// Everything here is pure logic on an injectable clock (tests run it in virtual time).

import { AbortedError } from "./blob-store.js";

// ── errors ──────────────────────────────────────────────────────────

/** A request that got no HTTP answer at all (connection refused/reset, DNS, offline, timeout). */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timeout = false,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

const NET_RE = /failed to fetch|fetch failed|networkerror|network error|load failed|network connection was lost|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i;

/** True for "no HTTP answer" (the link), false for HTTP errors, 429s, aborts and bugs. */
export function isNetworkError(e: unknown): boolean {
  const x = e as { name?: string; message?: string; cause?: unknown } | null;
  if (!x) return false;
  if (x.name === "AbortError") return false;
  if (x.name === "NetworkError" || x.name === "TimeoutError") return true;
  if (e instanceof TypeError && NET_RE.test(String(x.message))) return true;
  return NET_RE.test(String(x.message ?? "")) || (!!x.cause && x.cause !== e && isNetworkError(x.cause));
}

export function isTimeout(e: unknown): boolean {
  const x = e as { name?: string; timeout?: boolean } | null;
  return !!x && (x.name === "TimeoutError" || (x.name === "NetworkError" && !!x.timeout));
}

// ── clock ───────────────────────────────────────────────────────────

export interface NetClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  random(): number;
}

export const realClock: NetClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

/** Wait with jitter: base × (0.5 … 1.5). Retries of many clients must not line up. */
export function jitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.5 + random()));
}

export type NetEmit = (ev: string, f: Record<string, unknown>) => void;

// ── adaptive window (pieces in flight) ──────────────────────────────

/**
 * Pieces in flight for one direction, like a TCP congestion window: a network error or timeout halves it
 * (once per "loss event": failures of requests that started before the last cut do not cut again), down
 * to `min` (2); successes raise it by one every ceil(limit / 4) answers, up to the configured maximum.
 * 429s and HTTP errors do not touch it (the per-channel pacer handles 429s). Starts at the maximum, so a
 * good link sees no change at all.
 */
export class AdaptiveWindow {
  limit: number;
  private max_: number;
  private okRun = 0;
  private lastCutAt = -Infinity;
  /** Last network error / timeout seen (weak-link state for the UI). */
  lastErrAt = -Infinity;
  inUse = 0;
  private waiters: (() => void)[] = [];
  cuts = 0;
  /** Called when the limit changes (DriveClient: start more downloads at once). */
  onChange: (() => void) | null = null;

  constructor(
    readonly dir: "up" | "down",
    max: number,
    private readonly clock: NetClock = realClock,
    private readonly emit: NetEmit = () => {},
  ) {
    this.max_ = Math.max(1, max);
    this.limit = this.max_;
  }

  get max(): number {
    return this.max_;
  }
  get min(): number {
    return Math.min(2, this.max_);
  }

  /** New maximum (Settings, save data, channels). A window that was never cut follows it. */
  setMax(n: number): void {
    n = Math.max(1, Math.round(n));
    if (n === this.max_) return;
    // Follows only when not cut, or the last network error is over a minute old.
    const wasFull = this.limit >= this.max_ && this.clock.now() - this.lastErrAt >= 60_000;
    this.max_ = n;
    this.limit = wasFull ? n : Math.max(this.min, Math.min(this.limit, n));
    this.wake();
  }

  /** An HTTP answer (any status except 429 counts as the link working). */
  ok(): void {
    if (this.limit >= this.max_) return void (this.okRun = 0);
    if (++this.okRun >= Math.ceil(this.limit / 4)) {
      this.okRun = 0;
      this.limit++;
      this.emit("win", { dir: this.dir, lim: this.limit, max: this.max_, why: "ok" });
      this.wake();
    }
  }

  /** A network error or timeout of a request that started at `startedAt`. */
  fail(startedAt: number, why: "net" | "timeout" = "net"): void {
    const now = this.clock.now();
    this.lastErrAt = now;
    this.okRun = 0;
    if (startedAt < this.lastCutAt) return; // the same loss event (it was in flight when we cut)
    if (this.limit <= this.min) return;
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    this.lastCutAt = now;
    this.cuts++;
    this.emit("win", { dir: this.dir, lim: this.limit, max: this.max_, why });
  }

  /** Weak link right now: cut below the maximum and an error within the last minute. */
  weak(now = this.clock.now()): boolean {
    return this.limit < this.max_ && now - this.lastErrAt < 60_000;
  }

  /** A slot for one piece (upload workers); the returned function frees it. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.inUse >= this.limit) {
      if (signal?.aborted) throw new AbortedError();
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.inUse++;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.inUse--;
      this.wake();
    };
  }

  private wake(): void {
    const w = this.waiters.splice(0);
    for (const f of w) f();
    this.onChange?.();
  }
}

// ── gate: no network → wait, probe, resume ─────────────────────────

export type GateState = "open" | "offline" | "down";
export interface GateTicket {
  probe: boolean;
}

export interface GateOptions {
  /** Network errors in a row (no answer in between) that mean "no network". */
  failsToClose?: number;
  /** First probe after ~this (with jitter), doubling up to maxMs. */
  baseMs?: number;
  maxMs?: number;
  /** A probe that never reports (aborted, lost) is given up after this. */
  probeTimeoutMs?: number;
}

/**
 * Open while the network works. Closed by the browser's `offline` event ("offline": no probes at all,
 * zero traffic until `online`) or by `failsToClose` network errors in a row ("down": one probe request
 * after a growing pause with jitter; its success opens the gate for everyone). Requests that fail while
 * the gate is closed do not count against their retry limit: they wait at the gate instead.
 */
export class NetGate {
  state: GateState = "open";
  private fails = 0;
  private backoff = 0;
  private timer: unknown = null;
  private probeOut = false;
  private probeFree = false;
  private probeTimer: unknown = null;
  private waiters: { resolve: (t: GateTicket) => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  readonly o: Required<GateOptions>;
  /** When the gate opened again after being closed (UI: "resumed"). */
  resumedAt = -Infinity;
  closedAt = -Infinity;
  /** Time spent closed (ms), for reports. */
  closedMs = 0;
  probes = 0;
  onState: ((s: GateState) => void) | null = null;

  constructor(
    private readonly clock: NetClock = realClock,
    private readonly emit: NetEmit = () => {},
    o: GateOptions = {},
  ) {
    this.o = { failsToClose: o.failsToClose ?? 3, baseMs: o.baseMs ?? 1000, maxMs: o.maxMs ?? 60_000, probeTimeoutMs: o.probeTimeoutMs ?? 150_000 };
  }

  get open(): boolean {
    return this.state === "open";
  }

  /** Wait until a request may go out. */
  pass(signal?: AbortSignal): Promise<GateTicket> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (this.state === "open") return Promise.resolve({ probe: false });
    if (this.probeFree) {
      this.probeFree = false;
      return Promise.resolve(this.takeProbe());
    }
    return new Promise<GateTicket>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new AbortedError());
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  private lastFailAt = -Infinity;

  /**
   * Any HTTP answer: the network works. An answer to a request sent BEFORE the last failure proves
   * nothing about now (it was on its way when the link dropped): it does not reset the count.
   */
  ok(t?: GateTicket, startedAt = Infinity): void {
    if (startedAt >= this.lastFailAt) this.fails = 0;
    if (t?.probe) this.endProbe();
    if (this.state !== "open" && (t?.probe || startedAt >= this.lastFailAt)) this.openNow("answer");
  }

  /** A network-level failure (no HTTP answer). */
  fail(t?: GateTicket): void {
    if (this.state === "offline") return;
    this.lastFailAt = this.clock.now();
    if (this.state === "open") {
      if (++this.fails >= this.o.failsToClose) {
        this.close("down", "errors");
        this.schedule();
      }
      return;
    }
    // down: only the probe moves the backoff; the other failures are pieces that were already in flight
    if (t?.probe) {
      this.endProbe();
      this.backoff++;
      this.schedule();
    }
  }

  /** navigator.onLine / online / offline events. */
  setOnline(on: boolean): void {
    if (!on) {
      if (this.state === "offline") return;
      this.close("offline", "event");
      this.clearTimers();
      this.probeOut = false;
      this.probeFree = false;
      return;
    }
    if (this.state !== "open") this.openNow("online");
    this.fails = 0;
  }

  private close(s: GateState, why: string): void {
    const was = this.state;
    this.state = s;
    if (was === "open") this.closedAt = this.clock.now();
    this.emit("gate", { st: s, why });
    this.onState?.(s);
  }

  private openNow(why: string): void {
    const now = this.clock.now();
    this.closedMs += Math.max(0, now - this.closedAt);
    this.state = "open";
    this.fails = 0;
    this.backoff = 0;
    this.clearTimers();
    this.probeOut = false;
    this.probeFree = false;
    this.resumedAt = now;
    this.emit("gate", { st: "open", why, waited: Math.round(now - this.closedAt) });
    this.onState?.("open");
    for (const w of this.waiters.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.resolve({ probe: false });
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.probeTimer !== null) this.clock.clearTimeout(this.probeTimer);
    this.timer = this.probeTimer = null;
  }

  private schedule(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    const ms = jitter(Math.min(this.o.maxMs, this.o.baseMs * 2 ** Math.min(this.backoff, 20)), this.clock.random);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.state !== "down" || this.probeOut) return;
      const w = this.waiters.shift();
      if (!w) return void (this.probeFree = true);
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.resolve(this.takeProbe());
    }, ms);
  }

  private takeProbe(): GateTicket {
    this.probeOut = true;
    this.probes++;
    this.emit("gate", { st: "probe", n: this.probes });
    this.probeTimer = this.clock.setTimeout(() => {
      this.probeTimer = null;
      if (!this.probeOut || this.state !== "down") return;
      this.probeOut = false;
      this.schedule();
    }, this.o.probeTimeoutMs);
    return { probe: true };
  }

  private endProbe(): void {
    this.probeOut = false;
    if (this.probeTimer !== null) this.clock.clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}

// ── reference speed of this device ─────────────────────────────────

export interface Peak {
  /** When measured (ms). */
  t: number;
  /** Bytes per second. */
  bps: number;
  /** Network type when known (navigator.connection.type), else "". */
  net: string;
}

export interface BaselineData {
  v: 1;
  up: Peak[];
  down: Peak[];
}

/**
 * The device's own reference speed per direction, from real transfers (no speed test): the median of
 * the peaks (best 10 s) of the last few transfers that lasted long enough, measured within the last
 * week, on the same network type when the browser tells it. A probe that says "it is the line" adds the
 * slow speed as a peak, so after a move to a slower network the reference follows within a few
 * transfers. Needs at least 2 peaks (a new device first collects data).
 */
export class SpeedBaseline {
  data: BaselineData = { v: 1, up: [], down: [] };
  static readonly MAX_AGE_MS = 7 * 24 * 3600_000;
  static readonly KEEP = 10;
  static readonly USE = 5;
  /** Called after every change (the app stores it). */
  onSave: ((d: BaselineData) => void) | null = null;

  load(d: unknown): void {
    const x = d as Partial<BaselineData> | null;
    const ok = (a: unknown): Peak[] => (Array.isArray(a) ? a.filter((p): p is Peak => !!p && typeof p.t === "number" && typeof p.bps === "number" && p.bps > 0).map((p) => ({ t: p.t, bps: p.bps, net: typeof p.net === "string" ? p.net : "" })) : []);
    if (x && x.v === 1) this.data = { v: 1, up: ok(x.up).slice(-SpeedBaseline.KEEP), down: ok(x.down).slice(-SpeedBaseline.KEEP) };
  }

  value(dir: "up" | "down", now: number, net = ""): number | null {
    const fresh = this.data[dir].filter((p) => now - p.t < SpeedBaseline.MAX_AGE_MS && now - p.t > -60_000);
    const same = net ? fresh.filter((p) => p.net === net) : fresh;
    const use = (same.length >= 2 ? same : net ? [] : fresh).slice(-SpeedBaseline.USE);
    if (use.length < 2) return null;
    const s = use.map((p) => p.bps).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }

  add(dir: "up" | "down", bps: number, now: number, net = ""): void {
    if (!(bps > 0) || !Number.isFinite(bps)) return;
    const a = this.data[dir];
    a.push({ t: now, bps: Math.round(bps), net });
    while (a.length > SpeedBaseline.KEEP) a.shift();
    this.onSave?.(this.data);
  }
}

// ── stuck-connection guard ─────────────────────────────────────────

export interface GuardOptions {
  /** No judgement during the first part of a busy period (connections warming up). */
  warmupMs?: number;
  /** Length of the slow stretch that counts. */
  windowMs?: number;
  /** "Slow" = below this share of the reference speed. */
  ratio?: number;
  /** Reference below this (bytes/s): the guard stays off (nothing to gain, the link itself is slow). */
  minBaseline?: number;
  /** After a probe: no new probe before this. */
  cooldownMs?: number;
  /** The probe piece must be at least this many times faster than everything on the old connection together. */
  probeFactor?: number;
  minSamples?: number;
  /** Narrow pipe: median time to first byte at most this share of the median piece time (downloads). */
  ttfbShare?: number;
  /** Peaks for the reference: best window of this length. */
  peakMs?: number;
}

export interface GuardHost {
  /** Connections ("lanes") the requests can go on; the guard needs 2. */
  lanes(): number;
  /** Switch in Settings on, not metered / save data. */
  enabled(): boolean;
  /** No network right now (gate closed). */
  offline(): boolean;
  baseline: SpeedBaseline;
  netType(): string;
}

interface Sample {
  t0: number;
  t1: number;
  b: number;
  ttfb: number;
  lane: number;
}

export interface GuardHandle {
  lane: number;
  probe: boolean;
  t0: number;
}

/**
 * Watches the pieces of one direction (every request is reported anyway: no extra traffic) and, when
 * the transfer is slow WITHOUT errors while the first byte comes fast — the sign of one narrow shared
 * connection — sends the next needed piece on the other connection. Only if that piece alone is
 * clearly faster than everything on the old connection together do NEW requests go to the other one;
 * running requests finish where they are. Otherwise it is the line: nothing changes, and the next try
 * is minutes away. Peaks of long busy periods feed the reference speed.
 */
export class StuckGuard {
  /** The connection new requests use. */
  lane = 0;
  private readonly flight: number[] = [0, 0, 0, 0];
  private busySince: number | null = null;
  private samples: Sample[] = [];
  private probe: { lane: number; thrBefore: number } | null = null;
  private probeWanted = false;
  private cooldownUntil = -Infinity;
  private lastTroubleAt = -Infinity;
  private peak = 0;
  readonly o: Required<GuardOptions>;
  readonly stats = { detects: 0, probes: 0, switches: 0, line: 0, failed: 0 };

  constructor(
    readonly dir: "up" | "down",
    private readonly host: GuardHost,
    private readonly clock: NetClock = realClock,
    private readonly emit: NetEmit = () => {},
    o: GuardOptions = {},
  ) {
    this.o = {
      warmupMs: o.warmupMs ?? 20_000,
      windowMs: o.windowMs ?? 30_000,
      ratio: o.ratio ?? 0.4,
      minBaseline: o.minBaseline ?? 5e6,
      cooldownMs: o.cooldownMs ?? 5 * 60_000,
      probeFactor: o.probeFactor ?? 1.2,
      minSamples: o.minSamples ?? 4,
      ttfbShare: o.ttfbShare ?? 0.25,
      peakMs: o.peakMs ?? 10_000,
    };
  }

  private inFlight(): number {
    return this.flight.reduce((a, b) => a + b, 0);
  }

  /** Idle = nothing in flight for this long (the gap between one piece and the next is not "idle"). */
  private static readonly IDLE_MS = 3000;
  private idleTimer: unknown = null;

  /** A guarded request starts: which connection it goes on. */
  start(): GuardHandle {
    const now = this.clock.now();
    if (this.idleTimer !== null) (this.clock.clearTimeout(this.idleTimer), (this.idleTimer = null));
    if (this.inFlight() === 0 && this.busySince === null) ((this.busySince = now), (this.peak = 0), (this.samples = []));
    let lane = this.lane;
    let probe = false;
    if (this.probeWanted && !this.probe && this.host.lanes() >= 2 && this.host.enabled()) {
      this.probeWanted = false;
      lane = (this.lane + 1) % this.host.lanes();
      probe = true;
      this.probe = { lane, thrBefore: this.throughput(now, this.lane) };
      this.stats.probes++;
      this.emit("guard", { dir: this.dir, st: "probe", from: this.lane, to: lane, thr: Math.round(this.probe.thrBefore) });
    } else this.probeWanted = false;
    this.flight[lane] = (this.flight[lane] ?? 0) + 1;
    return { lane, probe, t0: now };
  }

  /** Errors, 429s, no network: not a stuck connection; no judgement for a while. */
  trouble(): void {
    this.lastTroubleAt = this.clock.now();
  }

  /** The request ended. `ok` with the body read; `ttfb` ms to the response headers. */
  end(h: GuardHandle, r: { ok: boolean; bytes?: number; ttfb?: number; trouble?: boolean }): void {
    const now = this.clock.now();
    this.flight[h.lane] = Math.max(0, (this.flight[h.lane] ?? 0) - 1);
    if (!r.ok && r.trouble !== false) this.trouble();
    if (r.ok && r.bytes) {
      this.samples.push({ t0: h.t0, t1: now, b: r.bytes, ttfb: r.ttfb ?? 0, lane: h.lane });
      const keep = Math.max(this.o.windowMs, this.o.peakMs) * 2;
      while (this.samples.length && this.samples[0]!.t1 < now - keep) this.samples.shift();
      if (this.busySince !== null && now - this.busySince >= this.o.peakMs) this.peak = Math.max(this.peak, this.throughput(now, null, this.o.peakMs));
    }
    if (h.probe && this.probe) this.judge(h, r, now);
    if (this.inFlight() > 0) return this.detect(now);
    if (this.idleTimer === null)
      this.idleTimer = this.clock.setTimeout(() => {
        this.idleTimer = null;
        if (this.inFlight() === 0) this.idle(now);
      }, StuckGuard.IDLE_MS);
  }

  private judge(h: GuardHandle, r: { ok: boolean; bytes?: number; ttfb?: number }, now: number): void {
    const p = this.probe!;
    this.probe = null;
    this.cooldownUntil = now + this.o.cooldownMs;
    if (!r.ok || !r.bytes) {
      this.stats.failed++;
      this.emit("guard", { dir: this.dir, st: "fail", lane: h.lane });
      return;
    }
    // Body speed of the probe (the headers part is mostly latency).
    const body = Math.max(50, now - h.t0 - (this.dir === "down" ? (r.ttfb ?? 0) : 0));
    const speed = (r.bytes / body) * 1000;
    if (speed >= this.o.probeFactor * p.thrBefore) {
      this.stats.switches++;
      const from = this.lane;
      this.lane = p.lane;
      // a fresh stretch on the new connection
      this.busySince = now;
      this.samples = this.samples.filter((s) => s.lane === this.lane);
      this.emit("guard", { dir: this.dir, st: "switch", from, to: this.lane, probe: Math.round(speed), thr: Math.round(p.thrBefore) });
    } else {
      this.stats.line++;
      // It is the line (or the other connection is just as slow): the reference follows the line.
      this.host.baseline.add(this.dir, p.thrBefore, now, this.host.netType());
      this.emit("guard", { dir: this.dir, st: "line", probe: Math.round(speed), thr: Math.round(p.thrBefore) });
    }
  }

  private idle(now: number): void {
    const busy = this.busySince === null ? 0 : now - this.busySince;
    if (this.busySince !== null && busy >= this.o.warmupMs && this.peak > 0) this.host.baseline.add(this.dir, this.peak, now, this.host.netType());
    this.busySince = null;
    this.peak = 0;
    this.probeWanted = false;
  }

  /** Bytes/s of pieces that finished in the last `span` ms (on one lane, or all). */
  private throughput(now: number, lane: number | null, span = this.o.windowMs): number {
    let b = 0;
    for (const s of this.samples) if (s.t1 > now - span && (lane === null || s.lane === lane)) b += s.b;
    return (b / span) * 1000;
  }

  private detect(now: number): void {
    if (this.probe || this.probeWanted || now < this.cooldownUntil) return;
    if (this.host.lanes() < 2 || !this.host.enabled() || this.host.offline()) return;
    const base = this.host.baseline.value(this.dir, now, this.host.netType());
    if (base === null || base < this.o.minBaseline) return;
    if (this.busySince === null || now - this.busySince < this.o.warmupMs + this.o.windowMs) return;
    if (now - this.lastTroubleAt < this.o.windowMs) return;
    if ((this.flight[this.lane] ?? 0) < 2) return;
    const win = this.samples.filter((s) => s.t1 > now - this.o.windowMs && s.lane === this.lane);
    if (win.length < this.o.minSamples) return;
    const thr = this.throughput(now, this.lane);
    if (thr >= this.o.ratio * base) return;
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1]!;
    const dur = med(win.map((s) => s.t1 - s.t0));
    const ttfb = med(win.map((s) => s.ttfb));
    if (this.dir === "down" && !(ttfb <= this.o.ttfbShare * dur)) return;
    this.probeWanted = true;
    this.stats.detects++;
    this.emit("guard", { dir: this.dir, st: "detect", lane: this.lane, thr: Math.round(thr), base: Math.round(base), dur: Math.round(dur), ttfb: Math.round(ttfb) });
  }
}

// ── everything one client uses ─────────────────────────────────────

export interface NetControlOptions {
  clock?: NetClock;
  /** Metered link (phone / cellular / browser save-data); the "save data" switch is added on top. */
  metered?: () => boolean;
  netType?: () => string;
  gate?: GateOptions;
  guard?: GuardOptions;
}

export type NetUiState = "ok" | "weak" | "offline" | "resumed";

/**
 * Network state shared by the uploads and downloads of one client: the gate, a window per direction,
 * the download guard, the reference speed and the switches (save data, guard). Events go to the
 * transfer log (`win`, `gate`, `guard`).
 */
export class NetControl {
  readonly clock: NetClock;
  readonly gate: NetGate;
  readonly win: { up: AdaptiveWindow; down: AdaptiveWindow };
  readonly guard: StuckGuard;
  /**
   * Uploads: only watched, for the reference speed (one connection lane: never probes). The browser
   * shows no stuck-upload symptom (38–40 MB/s steady on one connection); the desktop agent would.
   */
  readonly guardUp: StuckGuard;
  readonly baseline = new SpeedBaseline();
  /** Settings → "Save data". */
  saveData = false;
  /** Settings → Diagnostics → stuck-connection guard. */
  guardOn = true;
  /** Connections available for downloads (2 when the app attached a second one). */
  laneCount = 1;
  private readonly metered_: () => boolean;
  private readonly netType_: () => string;
  emitTo: NetEmit | null = null;
  onState: ((s: NetUiState) => void) | null = null;
  private lastUi: NetUiState = "ok";

  constructor(o: NetControlOptions = {}) {
    this.clock = o.clock ?? realClock;
    this.metered_ = o.metered ?? (() => false);
    this.netType_ = o.netType ?? (() => "");
    const emit: NetEmit = (ev, f) => {
      this.emitTo?.(ev, f);
      this.ui();
    };
    this.gate = new NetGate(this.clock, emit, o.gate);
    this.win = { up: new AdaptiveWindow("up", 8, this.clock, emit), down: new AdaptiveWindow("down", 4, this.clock, emit) };
    this.guard = new StuckGuard(
      "down",
      {
        lanes: () => this.laneCount,
        enabled: () => this.guardOn && !this.metered(),
        offline: () => !this.gate.open,
        baseline: this.baseline,
        netType: () => this.netType_(),
      },
      this.clock,
      emit,
      o.guard,
    );
    this.guardUp = new StuckGuard(
      "up",
      { lanes: () => 1, enabled: () => false, offline: () => !this.gate.open, baseline: this.baseline, netType: () => this.netType_() },
      this.clock,
      emit,
      o.guard,
    );
  }

  /** Metered link or "save data": smaller windows, no guard, no extra transfers. */
  metered(): boolean {
    return this.saveData || this.metered_();
  }

  /** What the transfer panels show. */
  uiState(): NetUiState {
    const now = this.clock.now();
    if (!this.gate.open) return "offline";
    if (now - this.gate.resumedAt < 5000) return "resumed";
    if (this.win.up.weak(now) || this.win.down.weak(now)) return "weak";
    return "ok";
  }

  ui(): void {
    const s = this.uiState();
    if (s !== this.lastUi) {
      this.lastUi = s;
      this.onState?.(s);
    }
  }

  /**
   * One request through the gate and the window bookkeeping. `fn` gets the gate ticket; network errors
   * close the gate after a few, and while it is closed `retryFree` tells the caller not to count the
   * failure against its retry limit.
   */
  async attempt<T>(dir: "up" | "down", signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown; retryFree: boolean }> {
    const t = await this.gate.pass(signal);
    const t0 = this.clock.now();
    try {
      const v = await fn();
      this.gate.ok(t, t0);
      this.win[dir].ok();
      this.ui();
      return { ok: true, v };
    } catch (e) {
      if (signal?.aborted || (e as Error)?.name === "AbortError") throw signal?.aborted ? new AbortedError() : e;
      if (isNetworkError(e)) {
        this.gate.fail(t);
        this.win[dir].fail(t0, isTimeout(e) ? "timeout" : "net");
        this.guard.trouble();
        this.ui();
        return { ok: false, e, retryFree: !this.gate.open };
      }
      this.gate.ok(t, t0); // an HTTP answer: the network works
      if ((e as Error)?.name === "RateLimitedError") this.guard.trouble();
      else this.win[dir].ok();
      return { ok: false, e, retryFree: false };
    }
  }

  /** Sleep before retry `attempt` (1, 2, …): 500 ms × 2^(n-1), with jitter, at most 30 s. */
  backoffMs(attempt: number): number {
    return jitter(Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1)), this.clock.random);
  }
}

/** Errors that happened while the gate was closed: the caller retries them without counting (they wait at the gate). */
const FREE = new WeakSet<object>();
export function retryFree(e: unknown): boolean {
  return typeof e === "object" && e !== null && FREE.has(e);
}

/**
 * One request through the gate and the window (NetControl.attempt), throwing on failure. An error from
 * a closed gate is marked: `retryFree(e)` is true, the caller loops back without counting the attempt.
 */
export async function netCall<T>(net: NetControl | null | undefined, dir: "up" | "down", signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!net) return fn();
  const r = await net.attempt(dir, signal, fn);
  if (r.ok) return r.v;
  if (r.retryFree && typeof r.e === "object" && r.e !== null) FREE.add(r.e);
  throw r.e;
}

/** Timing of one request as the transfer logs see it; `lane` = connection used (0 = the page's own). */
export interface LaneTiming {
  ttfb?: number;
  st?: number;
  lane?: number;
}

/** A CDN read watched by the stuck-connection guard: it picks the connection (lane) and learns from the result. */
export async function guardedRead(net: NetControl | null | undefined, timing: LaneTiming, signal: AbortSignal | undefined, get: (lane: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  if (!net) return get(0);
  const h = net.guard.start();
  if (net.laneCount > 1) timing.lane = h.lane;
  try {
    const d = await get(h.lane);
    net.guard.end(h, { ok: true, bytes: d.byteLength, ttfb: timing.ttfb });
    return d;
  } catch (e) {
    net.guard.end(h, { ok: false, trouble: !signal?.aborted });
    throw e;
  }
}

/** An upload request watched for the reference speed (no probes, no other connection). */
export async function watchedPost<T>(net: NetControl | null | undefined, bytes: number, fn: () => Promise<T>): Promise<T> {
  if (!net) return fn();
  const h = net.guardUp.start();
  try {
    const v = await fn();
    net.guardUp.end(h, { ok: true, bytes });
    return v;
  } catch (e) {
    net.guardUp.end(h, { ok: false });
    throw e;
  }
}
