// Per-IP token buckets for the unauthenticated endpoints (challenge, login,
// account creation, rescue, pairing mailbox, shares). Memory only: a restart
// resets them, which is fine for abuse damping.
//
// Client IP: the socket peer, unless the peer is a trusted reverse proxy
// (e.g. nginx on another host); then the right-most X-Forwarded-For entry (the
// address nginx itself saw), falling back to X-Real-IP.

import type { IncomingMessage } from "node:http";

export interface BucketSpec {
  /** Burst size. */
  burst: number;
  /** Refill, tokens per minute. */
  perMin: number;
}

export class IpLimiter {
  private readonly b = new Map<string, { tokens: number; at: number }>();
  private lastSweep = 0;
  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 0 if allowed (a token is taken), else seconds to wait. */
  take(key: string): number {
    const t = this.now();
    if (t - this.lastSweep > 60_000) this.sweep(t);
    const rate = this.spec.perMin / 60_000;
    const cur = this.b.get(key) ?? { tokens: this.spec.burst, at: t };
    const tokens = Math.min(this.spec.burst, cur.tokens + (t - cur.at) * rate);
    if (tokens < 1) {
      this.b.set(key, { tokens, at: t });
      return Math.ceil((1 - tokens) / rate / 1000);
    }
    this.b.set(key, { tokens: tokens - 1, at: t });
    return 0;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    const full = this.spec.burst / (this.spec.perMin / 60_000);
    for (const [k, v] of this.b) if (t - v.at > full) this.b.delete(k);
  }
}

const strip = (a: string) => (a.startsWith("::ffff:") ? a.slice(7) : a);

export function clientIp(req: IncomingMessage, trustProxy: readonly string[]): string {
  const peer = strip(req.socket.remoteAddress ?? "?");
  if (!trustProxy.includes(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  if (last) return strip(last);
  const real = req.headers["x-real-ip"];
  return typeof real === "string" && real ? strip(real.trim()) : peer;
}
