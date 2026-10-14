// Client-side pacing of webhook posts (koncept §8.2, measured in §7 on 2026-10-06).
//
// Facts the design rests on:
//  - the binding limit is per CHANNEL (~30 messages/min sustained, after an
//    initial burst), shared by every webhook in that channel and every client;
//  - its 429 (`x-ratelimit-scope: shared`) comes while x-ratelimit-remaining is
//    still > 0, so response headers cannot predict it: pacing must be proactive;
//  - evenly paced traffic at 27/min and 36/min from 4 clients got zero 429s,
//    48/min got 9 %, flooding got up to 69 %;
//  - fragment size does not matter (8 MiB fragments: same ~29/min).
//
// So: one token bucket per channel, default 30/min with a small burst; a
// `shared` 429 empties the bucket, blocks for retry_after and lowers the rate
// (multiplicative decrease); successes creep it back up to `maxPerMin`
// (additive increase). All tabs/processes of one device should share one
// pacer (main tab, or BroadcastChannel/Web Locks later); separate devices of
// the same user each adapt on their own.

export interface PacerOptions {
  /** Starting sustained rate per channel (messages/min). */
  perMin?: number;
  /** Upper bound for additive increase (measured 0 × 429 at 36/min). */
  maxPerMin?: number;
  /** Lower bound for multiplicative decrease. */
  minPerMin?: number;
  /** Bucket capacity (requests that may go back to back). */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  perMin: number;
  blockedUntil: number;
  /** Serialises waiters so tokens are handed out in FIFO order. */
  tail: Promise<void>;
  /** Callers queued in acquire() and not served yet. */
  waiting: number;
}

export class ChannelPacer {
  private readonly buckets = new Map<string, Bucket>();
  readonly perMin: number;
  readonly maxPerMin: number;
  readonly minPerMin: number;
  readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Counters for reporting/tests. */
  readonly stats = { acquired: 0, waitedMs: 0, shared429: 0, other429: 0 };

  constructor(opts: PacerOptions = {}) {
    this.perMin = opts.perMin ?? 30;
    this.maxPerMin = opts.maxPerMin ?? 36;
    this.minPerMin = opts.minPerMin ?? 10;
    this.burst = opts.burst ?? 4;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, updatedAt: this.now(), perMin: this.perMin, blockedUntil: 0, tail: Promise.resolve(), waiting: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  private refill(b: Bucket): void {
    const t = this.now();
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.updatedAt) * b.perMin) / 60_000);
    b.updatedAt = t;
  }

  /** Limiter state of a channel for transfer logs (transfer-log.ts LimiterState). */
  state(key: string): { pm: number; tok: number; blk: number; q: number } {
    const b = this.bucket(key);
    this.refill(b);
    return { pm: Math.round(b.perMin * 10) / 10, tok: Math.round(b.tokens * 100) / 100, blk: Math.max(0, Math.round(b.blockedUntil - this.now())), q: b.waiting };
  }

  /** Current sustained rate for a channel (messages/min). */
  rate(key: string): number {
    return this.bucket(key).perMin;
  }

  /** Wait until one request may be sent to this channel. */
  acquire(key: string): Promise<void> {
    const b = this.bucket(key);
    b.waiting++;
    const turn = b.tail.then(async () => {
      for (;;) {
        this.refill(b);
        const block = b.blockedUntil - this.now();
        if (block > 0) {
          this.stats.waitedMs += block;
          await this.sleep(block);
          continue;
        }
        if (b.tokens >= 1) {
          b.tokens -= 1;
          b.waiting--;
          this.stats.acquired++;
          return;
        }
        const wait = Math.ceil(((1 - b.tokens) * 60_000) / b.perMin);
        this.stats.waitedMs += wait;
        await this.sleep(wait);
      }
    });
    b.tail = turn.catch(() => {});
    return turn;
  }

  /**
   * Milliseconds until `key` could hand out a token, counting requests already queued on it
   * (each costs one interval). Lets a server pick the channel that frees up first.
   */
  readyIn(key: string): number {
    const b = this.bucket(key);
    this.refill(b);
    const interval = 60_000 / b.perMin;
    const block = Math.max(0, b.blockedUntil - this.now());
    const ahead = b.waiting + 1 - b.tokens;
    return block + Math.max(0, Math.ceil(ahead * interval));
  }

  onSuccess(key: string): void {
    const b = this.bucket(key);
    b.perMin = Math.min(this.maxPerMin, b.perMin + 0.5);
  }

  onRateLimited(key: string, retryAfterMs: number, scope: string | null): void {
    const b = this.bucket(key);
    this.refill(b);
    b.blockedUntil = Math.max(b.blockedUntil, this.now() + retryAfterMs);
    if (scope === "shared") {
      this.stats.shared429++;
      b.tokens = 0;
      b.perMin = Math.max(this.minPerMin, b.perMin * 0.8);
    } else {
      this.stats.other429++;
    }
  }
}
