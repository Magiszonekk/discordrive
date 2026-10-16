// Live speed and time left of a transfer: a moving average over
// the last WINDOW_MS of byte progress samples, ETA from it. Pure (the clock is passed in), so the
// tests drive it without timers.

export const WINDOW_MS = 5000;

export class SpeedMeter {
  private readonly samples: [number, number][] = [];
  readonly startedAt: number;
  endedAt: number | null = null;
  done = 0;

  constructor(
    readonly total: number,
    now: number,
    private readonly windowMs = WINDOW_MS,
  ) {
    this.startedAt = now;
    this.samples.push([now, 0]);
  }

  add(done: number, now: number): void {
    this.done = done;
    this.samples.push([now, done]);
    // Keep one sample older than the window as the left edge.
    while (this.samples.length > 2 && this.samples[1]![0] <= now - this.windowMs) this.samples.shift();
  }

  finish(now: number): void {
    this.endedAt = now;
  }

  /** Bytes/s over the last window (null until there is ~0.5 s of data). */
  rate(now: number): number | null {
    const first = this.samples[0]!;
    const last = this.samples.at(-1)!;
    const from = Math.max(first[0], now - this.windowMs);
    const span = (now - from) / 1000;
    if (now - this.startedAt < 500 || span <= 0) return null;
    // Bytes since the left edge (interpolated at `from` when the first sample is older).
    let base = first[1];
    if (first[0] < from && this.samples.length > 1) {
      const nx = this.samples[1]!;
      base = first[1] + ((nx[1] - first[1]) * (from - first[0])) / Math.max(1, nx[0] - first[0]);
    }
    return Math.max(0, (last[1] - base) / span);
  }

  /** ms left at the current rate (null when unknown or stalled). */
  etaMs(now: number): number | null {
    const r = this.rate(now);
    if (!r || r <= 0) return null;
    return Math.round(((this.total - this.done) / r) * 1000);
  }

  /** Average bytes/s from start to end (or now). */
  average(now: number): number {
    const s = ((this.endedAt ?? now) - this.startedAt) / 1000;
    return s > 0 ? this.done / s : 0;
  }

  durationMs(now: number): number {
    return (this.endedAt ?? now) - this.startedAt;
  }
}

/** "1:05", "12 s", "1:02:03". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
