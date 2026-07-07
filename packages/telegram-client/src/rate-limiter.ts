// DiscorDrive v4 — Telegram sender rate limiter
//
// Telegram flood limits differ from Discord's header-driven buckets: safe
// sustained rate is ~1 message/second per chat, and 429s carry retry_after in
// the JSON body (no rate-limit headers). One bot maps to one private channel
// (like webhook→channel on Discord), so limiting per sender == per chat.

export interface TelegramSenderState {
  /** Earliest time this sender may send again (min-interval or 429 penalty). */
  nextAllowedAt: number;
  inFlight: number;
}

const DEFAULT_MIN_SEND_INTERVAL_MS = 1100; // conservative 1 msg/s per chat
const MAX_IN_FLIGHT_PER_SENDER = 1; // Telegram sends are serialized per chat

export class TelegramRateLimiter {
  private senders = new Map<string, TelegramSenderState>();

  constructor(private minSendIntervalMs = DEFAULT_MIN_SEND_INTERVAL_MS) {}

  private state(id: string): TelegramSenderState {
    let s = this.senders.get(id);
    if (!s) {
      s = { nextAllowedAt: 0, inFlight: 0 };
      this.senders.set(id, s);
    }
    return s;
  }

  canUse(id: string): boolean {
    const s = this.state(id);
    return Date.now() >= s.nextAllowedAt && s.inFlight < MAX_IN_FLIGHT_PER_SENDER;
  }

  reserve(id: string): void {
    this.state(id).inFlight += 1;
  }

  release(id: string): void {
    const s = this.state(id);
    s.inFlight = Math.max(0, s.inFlight - 1);
  }

  /** Call after every successful send to enforce the per-chat send interval. */
  recordSent(id: string): void {
    this.state(id).nextAllowedAt = Date.now() + this.minSendIntervalMs;
  }

  /** Call on HTTP 429 with the retry_after seconds from the response body. */
  recordRetryAfter(id: string, retryAfterSeconds: number): void {
    const s = this.state(id);
    s.nextAllowedAt = Math.max(s.nextAllowedAt, Date.now() + retryAfterSeconds * 1000);
  }

  getNextResetMs(ids: string[]): number {
    let earliest = Infinity;
    for (const id of ids) {
      const s = this.senders.get(id);
      const at = s ? s.nextAllowedAt : 0;
      if (at < earliest) earliest = at;
    }
    return earliest === Infinity ? 0 : Math.max(0, earliest - Date.now());
  }

  getStateSnapshot(id: string): { remaining: number; inFlight: number } {
    const s = this.state(id);
    return { remaining: this.canUse(id) ? 1 : 0, inFlight: s.inFlight };
  }
}
