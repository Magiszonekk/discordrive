// DiscorDrive v4 — Webhook rate limiter with Cloudflare IP ban protection
// Uses SLIDING WINDOW for global error tracking (not fixed window).

import { config } from "@ddv4/config";

interface WebhookState {
  remaining: number;
  resetAt: number; // Unix timestamp (ms)
  bucketHash: string;
  inFlight: number;
}

export class WebhookRateLimiter {
  private webhooks = new Map<string, WebhookState>();
  private errorTimestamps: number[] = []; // Sliding window for Cloudflare protection
  private roundRobinIndex = 0;

  recordResponse(webhookId: string, headers: Headers): void {
    const remaining = headers.get("x-ratelimit-remaining");
    const resetAfter = headers.get("x-ratelimit-reset-after");
    const bucket = headers.get("x-ratelimit-bucket");

    const state = this.webhooks.get(webhookId) ?? {
      remaining: config.webhookRateLimitDefault,
      resetAt: 0,
      bucketHash: "",
      inFlight: 0,
    };

    if (remaining !== null) {
      state.remaining = parseInt(remaining, 10);
    }
    if (resetAfter !== null) {
      state.resetAt = Date.now() + parseFloat(resetAfter) * 1000;
    }
    if (bucket !== null) {
      state.bucketHash = bucket;
    }

    this.webhooks.set(webhookId, state);
  }

  recordError(statusCode: number): void {
    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      this.errorTimestamps.push(Date.now());
    }
  }

  canUse(webhookId: string): boolean {
    const state = this.webhooks.get(webhookId);
    if (!state) return true; // Unknown webhook — assume available

    if (Date.now() >= state.resetAt) {
      // Window has reset — webhook is available
      return true;
    }

    return (state.remaining - state.inFlight) > 0;
  }

  reserve(webhookId: string): void {
    const state = this.webhooks.get(webhookId) ?? {
      remaining: config.webhookRateLimitDefault,
      resetAt: 0,
      bucketHash: "",
      inFlight: 0,
    };
    state.inFlight += 1;
    this.webhooks.set(webhookId, state);
  }

  release(webhookId: string): void {
    const state = this.webhooks.get(webhookId);
    if (!state) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    this.webhooks.set(webhookId, state);
  }

  getStateSnapshot(webhookId: string): WebhookState {
    return this.webhooks.get(webhookId) ?? {
      remaining: config.webhookRateLimitDefault,
      resetAt: 0,
      bucketHash: "",
      inFlight: 0,
    };
  }

  /**
   * Sliding window check: count errors in last 10 minutes.
   * Returns false if approaching Cloudflare's 10k/10min IP ban threshold.
   */
  isGlobalSafe(): boolean {
    const cutoff = Date.now() - config.cloudflareWindowMs;
    // Evict old timestamps
    this.errorTimestamps = this.errorTimestamps.filter((t) => t > cutoff);
    return this.errorTimestamps.length < config.cloudflareErrorThreshold;
  }

  /**
   * Round-robin selection among available webhooks.
   * Returns null if no webhook is available or global safety is compromised.
   */
  getBestWebhook(webhookIds: string[]): string | null {
    if (!this.isGlobalSafe()) return null;
    if (webhookIds.length === 0) return null;

    // Try round-robin starting from current index
    for (let i = 0; i < webhookIds.length; i++) {
      const idx = (this.roundRobinIndex + i) % webhookIds.length;
      const id = webhookIds[idx];
      if (this.canUse(id)) {
        this.roundRobinIndex = (idx + 1) % webhookIds.length;
        return id;
      }
    }

    return null;
  }

  /**
   * Wait until any webhook becomes available.
   * Uses getNextResetMs() to sleep until the earliest reset, then polls with short interval.
   */
  async waitForAvailable(webhookIds: string[]): Promise<string> {
    while (true) {
      const webhook = this.getBestWebhook(webhookIds);
      if (webhook) return webhook;

      // Sleep until the earliest webhook resets, clamped to 50ms–2s
      const nextReset = this.getNextResetMs(webhookIds);
      const delay = Math.max(50, Math.min(nextReset || 50, 2000));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Get the earliest reset time across all tracked webhooks.
   */
  getNextResetMs(webhookIds: string[]): number {
    let earliest = Infinity;
    for (const id of webhookIds) {
      const state = this.webhooks.get(id);
      if (state && state.resetAt < earliest) {
        earliest = state.resetAt;
      }
    }
    return earliest === Infinity ? 0 : Math.max(0, earliest - Date.now());
  }
}
