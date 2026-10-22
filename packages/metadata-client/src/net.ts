// Transfers on weak, unstable and "stuck" links.
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

export interface WindowOptions {
  /** Network errors within `spanMs` (since the last cut) before the window is cut… */
  burst?: number;
  /** …and at least this share of the requests that ended in that time failed. */
  share?: number;
  spanMs?: number;
  /** After a cut: back to the value before it once this long passed without a burst of errors. */
  recoverMs?: number;
}

/**
 * Pieces in flight for one direction, like a TCP congestion window, but cut only by a BURST of network
 * errors: at least `burst` (3) errors within `spanMs` (15 s) that are also at least `share` (25 %) of the
 * requests ending then. A single error among requests that keep succeeding (a connection reset, one
 * "Failed to fetch" on a fast line) is retried by the caller and leaves the window alone: two such errors
 * in a 300 MB upload used to halve 8 → 4 → 2 and the upload stayed at 2 (11.7 MB/s on a 68 MB/s line).
 * A cut halves the window (once per "loss event": failures of requests that started before the cut do
 * not cut again), down to `min` (2). Recovery: once `recoverMs` (20 s) passed after the cut without
 * another burst, the window goes straight back to the value before the cut (`good`); between that it
 * grows by one every ceil(limit / 4) answers. A cut soon after such a recovery means the old value was
 * too high: then there is no jump back, only the slow growth (and the tuner's next check).
 * 429s and HTTP errors do not touch it (the per-channel pacer handles 429s). Starts at the maximum, so a
 * good link sees no change at all.
 */
export class AdaptiveWindow {
  limit: number;
  private max_: number;
  private okRun = 0;
  private lastCutAt = -Infinity;
  /** Value before the last cut (recovery target); 0 = nothing to recover. */
  private good = 0;
  private recoveredAt = -Infinity;
  /** Outcomes of recent requests (time, network error or not), for the burst rule. */
  private recent: { t: number; err: boolean }[] = [];
  readonly o: Required<WindowOptions>;
  /** Network errors that did not cut (isolated among successes). */
  ignored = 0;
  recoveries = 0;
  /** Last network error / timeout of a burst (weak-link state for the UI). */
  lastErrAt = -Infinity;
  inUse = 0;
  private waiters: (() => void)[] = [];
  cuts = 0;
  /** Called when the limit changes (DriveClient: start more downloads at once). */
  onChange: (() => void) | null = null;
  /** Called after a cut by network errors with the new limit (the automatic value follows it). */
  onCut: ((limit: number) => void) | null = null;
  /** Called when the window goes back to the value before a cut (the automatic value follows it first). */
  onRecover: ((limit: number) => void) | null = null;

  constructor(
    readonly dir: "up" | "down",
    max: number,
    private readonly clock: NetClock = realClock,
    private readonly emit: NetEmit = () => {},
    o: WindowOptions = {},
  ) {
    this.max_ = Math.max(1, max);
    this.limit = this.max_;
    this.o = { burst: o.burst ?? 3, share: o.share ?? 0.25, spanMs: o.spanMs ?? 15_000, recoverMs: o.recoverMs ?? 20_000 };
  }

  private note(err: boolean, now: number): void {
    this.recent.push({ t: now, err });
    const from = now - this.o.spanMs;
    let i = 0;
    while (i < this.recent.length && this.recent[i]!.t < from) i++;
    if (i) this.recent.splice(0, i);
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);
  }

  /** A burst of errors right now: enough of them since the last cut, and a real share of what ended. */
  private burstNow(now: number): boolean {
    // Only what happened after the last cut counts (the errors that caused it are spent).
    let errs = 0;
    let all = 0;
    for (const r of this.recent) {
      if (r.t < now - this.o.spanMs || r.t <= this.lastCutAt) continue;
      all++;
      if (r.err) errs++;
    }
    return errs >= this.o.burst && errs >= this.o.share * all;
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
    const now = this.clock.now();
    this.note(false, now);
    // Recovery: long enough since the cut and no burst now → back to the value before the cut. Checked
    // before "at the maximum": with the automatic value the maximum itself was lowered to the cut value.
    if (this.good > this.limit && now - this.lastCutAt >= this.o.recoverMs && !this.burstNow(now)) {
      const to = this.good;
      this.good = 0;
      this.okRun = 0;
      this.recoveredAt = now;
      this.recoveries++;
      this.onRecover?.(to); // the automatic value goes back first (it is the window's maximum)
      this.limit = Math.max(this.limit, Math.min(this.max_, to));
      this.emit("win", { dir: this.dir, lim: this.limit, max: this.max_, why: "recover" });
      this.wake();
      return;
    }
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
    if (startedAt < this.lastCutAt) return void (this.lastErrAt = now); // the same loss event (in flight when we cut)
    this.note(true, now);
    if (!this.burstNow(now)) {
      // One error among requests that succeed: the caller retries it; the window stays, and it does not
      // count as a weak link (no "weak" in the UI, the window still follows a new maximum at once).
      this.ignored++;
      return;
    }
    this.lastErrAt = now;
    this.okRun = 0;
    if (this.limit <= this.min) return;
    // Cut again soon after a recovery: the value before was too high; no jump back this time (slow growth only).
    this.good = now - this.recoveredAt < 2 * this.o.recoverMs ? 0 : Math.max(this.good, this.limit);
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    this.lastCutAt = now;
    this.cuts++;
    this.emit("win", { dir: this.dir, lim: this.limit, max: this.max_, why });
    this.onCut?.(this.limit);
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

// ── automatic pieces in flight (no thresholds in MB/s) ──────────────

export interface TunerOptions {
  /** First value (before anything is measured). */
  start?: number;
  /** Upper bound (memory: ~20 MB per piece in flight; uploads also 2 × channels). */
  cap?: number;
  /** One step: × this (at least ±1). */
  factor?: number;
  /** A step up is kept only if the total speed grew by at least this share… */
  minGain?: number;
  /**
   * …or by at least this smaller share in TWO measurements in a row (the step is measured once more
   * before deciding): a real +8 % that one window of noise could fake is confirmed by the second.
   */
  smallGain?: number;
  /** A step down is kept if the speed fell by less than this share (fewer pieces, same speed). */
  maxLoss?: number;
  /** A measurement window is at least this long… */
  minSpanMs?: number;
  /** …and at least this many piece durations (long uploads on a slow line). */
  minPieces?: number;
  /** After settling: measure again after this long. */
  recheckMs?: number;
  /**
   * Also try fewer pieces when more gave nothing (uploads: long posts that only share a narrow line gain
   * nothing and break more easily). Off for downloads: there, extra pieces cost nothing but memory.
   */
  shrink?: boolean;
  /** Never below this. */
  min?: number;
}

/**
 * Why the value changed: `try` a step up from a measured value, `gain` the step helped (next one), `flat`
 * it did not (back), `try-fewer` one step below, `fewer` that was as fast (kept), `worse` it was not
 * (back), `errors` network errors cut it, `cap` the upper bound went down, `uncap` it rose again (the value
 * goes back to what the bound had cut).
 */
export type TuneWhy = "try" | "gain" | "confirm" | "flat" | "try-fewer" | "fewer" | "worse" | "errors" | "recover" | "cap" | "uncap";

/** A piece in flight as the tuner sees it (from begin() to end()/drop()). */
export type TuneToken = { t0: number };

/**
 * Pieces in flight for one direction, found by measuring instead of a fixed number: start small, step up
 * while the total speed keeps growing (≥ 10 % per step; × 2 in the first ramp and after a gain of ≥ 30 %,
 * else × 1.5), step back when it stops growing; uploads
 * then try one step down (fewer pieces at the same speed is better: long uploads that only share a narrow
 * line gain nothing and break more easily). Every `recheckMs` the same check runs again from the current value, so
 * a line that got faster or slower is followed. Network errors cut the value (AdaptiveWindow halves the
 * pieces in flight; the tuner takes that as its new value and measures again later).
 *
 * Measuring: every piece's bytes are spread evenly over its own duration, and a window is closed only at
 * the start of the oldest piece still running, so every byte inside the window is known (no error from
 * pieces finishing in bursts). A window starts only once the pieces started under the previous value have
 * finished, and is thrown away when the transfer ran out of pieces to start (end of a file, a small file,
 * the download's write buffer): it compares the line with n pieces against the line with m pieces.
 */
export class AutoTuner {
  target: number;
  cap: number;
  readonly o: Required<Omit<TunerOptions, "start" | "cap">>;
  /** Accepted value and the speed measured with it (bytes/s). */
  private base: { n: number; bps: number } | null = null;
  /** What the running measurement is for: the current value, a step up, a step down, or nothing (settled). */
  private phase: "base" | "up" | "down" | "hold" = "base";
  private triedDown = false;
  /** A step up helped in this check. */
  private gained = false;
  /** When the value last changed / the measurement restarted. */
  private since: number;
  /** Window start (null: pieces from before `since` still running). */
  private ws: number | null = null;
  private holdFrom = 0;
  private readonly active = new Set<TuneToken>();
  /** Finished pieces that may overlap the window. */
  private done: { t0: number; t1: number; b: number }[] = [];
  private lastDur = 0;
  /** Called with the new value (DriveClient: the window maximum). */
  onTarget: ((n: number) => void) | null = null;
  /** The last value measurements accepted (the current one may be a step being tried). */
  get accepted(): number {
    return this.phase === "hold" || !this.base ? this.target : this.base.n;
  }
  /** Recent changes (diagnostics). */
  readonly changes: { t: number; from: number; to: number; why: TuneWhy }[] = [];

  constructor(
    readonly dir: "up" | "down",
    o: TunerOptions = {},
    private readonly clock: NetClock = realClock,
    private readonly emit: NetEmit = () => {},
  ) {
    this.o = { factor: o.factor ?? 1.5, minGain: o.minGain ?? 0.1, smallGain: o.smallGain ?? 0.05, maxLoss: o.maxLoss ?? 0.05, minSpanMs: o.minSpanMs ?? 6000, minPieces: o.minPieces ?? 1.5, recheckMs: o.recheckMs ?? 60_000, shrink: o.shrink ?? false, min: Math.max(1, o.min ?? 2) };
    this.cap = Math.max(1, Math.round(o.cap ?? 32));
    this.start = Math.round(o.start ?? 4);
    this.target = Math.max(Math.min(this.o.min, this.cap), Math.min(this.cap, this.start));
    this.since = clock.now();
  }

  /**
   * The value the bound cut away (null: none). A cut by the bound is not a measurement: an app that starts
   * with one channel (bound 3) and gets nine more must not keep 3 for the session (and remember it).
   */
  private capped: number | null = null;
  /** The first value: a remembered value never starts below it (the tuner goes lower by measuring). */
  private readonly start: number;

  /**
   * New upper bound (channels, memory): the value follows down at once; when the bound rises again, it goes
   * back to what the bound had cut (at most the new bound), the rest only by measuring.
   */
  setCap(cap: number): void {
    cap = Math.max(1, Math.round(cap));
    if (cap === this.cap) return;
    this.cap = cap;
    if (this.target > cap) {
      this.capped = Math.max(this.capped ?? 0, this.target);
      this.change(cap, "cap", null, null, this.measured > 0 || this.base ? "hold" : "base");
    } else if (this.capped !== null && this.target < this.capped) {
      const n = Math.min(cap, this.capped);
      if (n >= this.capped) this.capped = null;
      // Nothing measured yet: measure from there (the first ramp); otherwise hold it until the next check.
      this.change(n, "uncap", null, null, this.measured > 0 ? "hold" : "base");
    }
  }

  /** The value is at the bound (a measurement there says nothing about more pieces). */
  get atCap(): boolean {
    return this.target >= this.cap;
  }

  /** Value before the last cut by errors (what a recovery goes back to). */
  private beforeLoss = 0;

  /** Network errors left `limit` pieces in flight (AdaptiveWindow cut): that is the value now; measure again later. */
  loss(limit: number): void {
    const n = Math.max(1, Math.min(this.target, Math.round(limit)));
    this.base = null;
    if (n < this.target) {
      this.beforeLoss = Math.max(this.beforeLoss, this.accepted);
      this.change(n, "errors", null, null, "hold");
    } else this.settle(this.clock.now());
  }

  /**
   * The errors are over (AdaptiveWindow recovered to `limit`): back to that value, the one measured
   * before the cut at most. Without this the value stayed at the cut one until the next check (a minute,
   * longer than most files), and a short burst of errors cost the rest of the upload.
   */
  recover(limit: number): void {
    const n = Math.min(this.cap, Math.max(1, Math.round(Math.min(limit, this.beforeLoss || limit))));
    this.beforeLoss = 0;
    if (n > this.target) this.change(n, "recover", null, null, "hold");
  }

  /** A piece starts (a slot is taken). */
  begin(): TuneToken {
    const tk = { t0: this.clock.now() };
    this.active.add(tk);
    return tk;
  }

  /** A piece failed or was cancelled: it no longer counts. */
  drop(tk: TuneToken): void {
    this.active.delete(tk);
    this.restart(this.clock.now());
  }

  /** A piece finished with `b` bytes; `more` = the transfer still had pieces waiting to start (the slots were the limit). */
  end(tk: TuneToken, b: number, more: boolean): void {
    if (!this.active.delete(tk)) return;
    const now = this.clock.now();
    this.lastDur = now - tk.t0;
    if (this.phase === "hold") {
      if (!more || now - this.holdFrom < this.o.recheckMs) return;
      this.phase = "base"; // check again: measure the current value first
      this.triedDown = false;
      this.gained = false;
      return this.restart(now);
    }
    if (!more) return this.restart(now);
    if (tk.t0 >= this.since || this.ws !== null) this.done.push({ t0: tk.t0, t1: now, b });
    if (this.ws === null) {
      // The window opens once every piece started under the previous value has finished.
      let old = false;
      for (const a of this.active) if (a.t0 < this.since) old = true;
      if (old) return;
      this.ws = now;
      return;
    }
    // Close the window at the oldest piece still running: every byte before it is known.
    let we = now;
    for (const a of this.active) we = Math.min(we, a.t0);
    const span = we - this.ws;
    if (span < Math.max(this.o.minSpanMs, this.o.minPieces * this.lastDur)) return;
    let bytes = 0;
    for (const d of this.done) {
      const ov = Math.min(d.t1, we) - Math.max(d.t0, this.ws);
      if (ov > 0) bytes += (d.b * ov) / Math.max(1, d.t1 - d.t0);
    }
    this.decide((bytes / span) * 1000, now);
  }

  private restart(now: number): void {
    this.since = now;
    this.ws = null;
    this.done = [];
  }

  private settle(now: number): void {
    const wasChecking = this.phase !== "hold";
    this.phase = "hold";
    this.holdFrom = now;
    this.restart(now);
    if (wasChecking && this.base) {
      this.measured++;
      this.lastGain = 0;
      this.onAccept?.(this.base.n);
    }
  }

  /** Speed of the first window of a step with a small gain (0 = none pending). */
  private firstSmall = 0;

  /** Gain of the last step up (share); a big one, or the very first ramp, doubles instead of × factor. */
  private lastGain = 0;
  private up(n: number): number {
    const f = this.lastGain >= 0.3 || this.measured === 0 ? 2 : this.o.factor;
    return Math.min(this.cap, Math.max(n + 1, Math.round(n * f)));
  }
  /** Checks finished so far (0: the first ramp, which doubles like a TCP slow start). */
  private measured = 0;
  /** Called with every value measurements accepted (a step that helped, or where a check settled); the app remembers it. */
  onAccept: ((n: number) => void) | null = null;

  /** Start from a value learned earlier (another session): used until the first check measures it. */
  seed(n: number): void {
    // Bound changes (channels added at start) are not measurements: a value remembered from earlier still applies.
    if (!(n >= 1) || this.measured > 0 || this.changes.some((c) => c.why !== "cap" && c.why !== "uncap")) return;
    // Not below the first value: a value remembered from a session cut short (a narrow bound, a small
    // file) would otherwise stay the start for good; a narrow line goes down again by measuring.
    n = Math.max(n, this.start);
    if (this.target < n && this.cap < n) this.capped = Math.max(this.capped ?? 0, n);
    const v = Math.max(Math.min(this.o.min, this.cap), Math.min(this.cap, Math.round(n)));
    if (v === this.target) return;
    this.target = v;
    this.measured = 1; // a known value: no doubling ramp from it
    this.onTarget?.(v);
  }
  private down(n: number): number {
    return Math.max(this.o.min, Math.min(n - 1, Math.round(n / this.o.factor)));
  }

  private decide(bps: number, now: number): void {
    const n = this.target;
    const b = this.base;
    if (this.phase === "base" || !b) {
      this.base = { n, bps };
      return this.up(n) > n ? this.change(this.up(n), "try", [n, bps], null, "up", now) : this.tryDown(n, bps, now);
    }
    if (this.phase === "up") {
      // A small gain: measure the same step once more; both windows above smallGain = a real gain.
      const small = bps >= b.bps * (1 + this.o.smallGain);
      if (!this.firstSmall && small && bps < b.bps * (1 + this.o.minGain)) {
        this.firstSmall = bps;
        this.log(n, n, "confirm", [b.n, b.bps], [n, bps]);
        return this.restart(now);
      }
      const confirmed = this.firstSmall > 0 && small && (this.firstSmall + bps) / 2 >= b.bps * (1 + this.o.smallGain);
      if (this.firstSmall && !confirmed) bps = Math.min(bps, this.firstSmall);
      this.firstSmall = 0;
      if (bps >= b.bps * (1 + this.o.minGain) || confirmed) {
        this.lastGain = b.bps > 0 ? bps / b.bps - 1 : 1;
        this.base = { n, bps };
        this.gained = true;
        // Remembered at once, not only when the check settles: a file often ends while the next step is
        // still being tried (1 GB upload on a fast line), and the next session should start from here.
        this.onAccept?.(n);
        return this.up(n) > n ? this.change(this.up(n), "gain", [b.n, b.bps], [n, bps], "up", now) : this.settle(now);
      }
      // No gain from the step: back to the accepted value. If this check had no gain at all, see whether
      // fewer pieces do as well (after a gain the step below is already known to be slower).
      this.change(b.n, "flat", [b.n, b.bps], [n, bps], "base", now);
      return this.gained ? this.settle(now) : this.tryDown(b.n, b.bps, now);
    }
    // phase "down": about the same speed with fewer pieces → keep fewer
    if (bps >= b.bps * (1 - this.o.maxLoss)) {
      this.base = { n, bps };
      this.log(b.n, n, "fewer", [b.n, b.bps], [n, bps]);
      return this.settle(now);
    }
    this.change(b.n, "worse", [b.n, b.bps], [n, bps], "hold", now);
    this.settle(now);
  }

  private tryDown(n: number, bps: number, now: number): void {
    if (!this.o.shrink || this.triedDown || this.down(n) >= n) return this.settle(now);
    this.triedDown = true;
    this.base = { n, bps };
    this.change(this.down(n), "try-fewer", [n, bps], null, "down", now);
  }

  /** `a`, `m`: [pieces, bytes/s] of the accepted value and of the value just measured (logs). */
  private change(n: number, why: TuneWhy, a: [number, number] | null, m: [number, number] | null, phase: AutoTuner["phase"], now = this.clock.now()): void {
    const from = this.target;
    this.target = n;
    this.phase = phase;
    this.firstSmall = 0;
    if (phase === "hold") this.holdFrom = now;
    this.restart(now);
    this.log(from, n, why, a, m);
    if (n !== from) this.onTarget?.(n);
  }

  private log(from: number, to: number, why: TuneWhy, a: [number, number] | null, m: [number, number] | null): void {
    this.changes.push({ t: this.clock.now(), from, to, why });
    if (this.changes.length > 100) this.changes.shift();
    // an/ab: pieces and speed (bytes/s) of the accepted value; mn/mb: of the value just measured.
    this.emit("tune", { dir: this.dir, from, to, why, ...(a ? { an: a[0], ab: Math.round(a[1]) } : {}), ...(m ? { mn: m[0], mb: Math.round(m[1]) } : {}) });
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
  /** Automatic pieces in flight (tests: shorter measurements). */
  tune?: TunerOptions;
  /** When network errors cut the window and when it recovers (tests). */
  window?: WindowOptions;
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
  /** Automatic pieces in flight per direction (used when the setting is empty). */
  readonly tune: { up: AutoTuner; down: AutoTuner };
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
    this.win = { up: new AdaptiveWindow("up", 8, this.clock, emit, o.window), down: new AdaptiveWindow("down", 4, this.clock, emit, o.window) };
    // Uploads start at 8 (a measurement step there takes a piece's whole post time, so a ramp from 4 eats
    // much of a 1 GB file on a fast line; on a narrow one the tuner goes down again), downloads at 4.
    // Uploads: a window of one piece time (≥ 4 s) per step instead of 1.5 (a post of 10 MiB takes several
    // seconds, so 1.5 piece times per step left a 1 GB upload on a fast line still ramping when it ended).
    // Downloads: the same window (a CDN read of 10 MiB takes ~5 s on a fast line; 1.5 piece times plus the
    // wait for older pieces made the first step to 8 come only after ~40 s, longer than a 300 MB file).
    this.tune = { up: new AutoTuner("up", { start: 8, shrink: true, minPieces: 1, minSpanMs: 4000, ...o.tune }, this.clock, emit), down: new AutoTuner("down", { start: 4, minPieces: 1, minSpanMs: 4000, ...o.tune }, this.clock, emit) };
    // Network errors cut the window; the automatic value follows the cut and is measured again later.
    this.win.up.onCut = (l) => this.tune.up.loss(l);
    this.win.down.onCut = (l) => this.tune.down.loss(l);
    this.win.up.onRecover = (l) => this.tune.up.recover(l);
    this.win.down.onRecover = (l) => this.tune.down.recover(l);
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
