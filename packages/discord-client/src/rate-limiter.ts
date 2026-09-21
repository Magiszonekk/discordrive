// DiscorDrive v4 — Webhook rate limiter with Cloudflare IP ban protection
// Uses SLIDING WINDOW for global error tracking (not fixed window).

import { config } from "@ddv4/config";

interface WebhookState {
  remaining: number;
  resetAt: number; // Unix timestamp (ms)
  bucketHash: string;
  inFlight: number;
}

/** Default egress key for requests sent directly from this host's own IP. */
export const DIRECT_EGRESS_KEY = "direct";

export class WebhookRateLimiter {
  private webhooks = new Map<string, WebhookState>();
  private errorTimestamps: number[] = []; // Sliding window for Cloudflare protection
  private roundRobinIndex = 0;

  /**
   * Unix ms until which Cloudflare is blocking a given EGRESS PATH, keyed by
   * egress key (e.g. "direct" for this host's own IP, "proxy:oracle" for a
   * forward proxy on a different IP, "proxy:home" for another). A block on
   * one egress key says nothing about another — that is the entire point of
   * having more than one egress path. Bots are never tracked here: they use
   * a completely different Discord API route ("/channels/{id}/messages") that a
   * webhook-route ban does not touch, so they have no block state at all.
   */
  private cloudflareBlockedUntil = new Map<string, number>();

  /**
   * Rolling log of ALL webhook requests attempted per egress key (not just
   * errors). This is what makes throttling proactive instead of reactive:
   * cloudflareErrorThreshold/isGlobalSafe() below only react to 401/403/429
   * responses that already happened. Cloudflare's own ban threshold counts
   * every request, so approaching it can be predicted and slowed down before
   * a single 429 is ever seen.
   */
  private egressRequestTimestamps = new Map<string, number[]>();

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

  /**
   * Remember that a sender is throttled until a point in time, and whether the
   * throttle came from Cloudflare (IP-level, applies to every webhook reached
   * through the SAME egress path) rather than Discord (per-route).
   *
   * `egressKey` identifies which egress path saw the block — defaults to this
   * host's own IP ("direct"). A proxy/relay egress must pass its own key so a
   * block discovered on one path never silently blocks a different, healthy
   * path — proxies exist specifically to survive a direct-path ban.
   *
   * Without this the limiter counted 429s but never acted on them: canUse()
   * kept returning true because only x-ratelimit-* headers ever mutated state,
   * and a Cloudflare 1015 sends none. Every subsequent attempt re-dialled the
   * banned route, ate another 429, and slept again.
   */
  recordThrottle(
    webhookId: string,
    retryAfterMs: number,
    cloudflareBlocked: boolean,
    egressKey: string = DIRECT_EGRESS_KEY,
  ): void {
    const until = Date.now() + retryAfterMs;
    if (cloudflareBlocked) {
      // IP-level: no webhook reached through THIS egress path will work until
      // it lifts. Other egress paths (different key) are unaffected.
      const existing = this.cloudflareBlockedUntil.get(egressKey) ?? 0;
      this.cloudflareBlockedUntil.set(egressKey, Math.max(existing, until));
      return;
    }
    const state = this.webhooks.get(webhookId) ?? {
      remaining: config.webhookRateLimitDefault,
      resetAt: 0,
      bucketHash: "",
      inFlight: 0,
    };
    state.remaining = 0;
    state.resetAt = Math.max(state.resetAt, until);
    this.webhooks.set(webhookId, state);
  }

  /**
   * Milliseconds until the Cloudflare IP block lifts for a given egress path,
   * or 0 when not blocked. Callers should surface this instead of attempting
   * a call that cannot work. Defaults to this host's own IP.
   */
  cloudflareBlockRemainingMs(egressKey: string = DIRECT_EGRESS_KEY): number {
    return Math.max(0, (this.cloudflareBlockedUntil.get(egressKey) ?? 0) - Date.now());
  }

  /** True if ANY egress path is currently free of a Cloudflare block. */
  hasAnyUnblockedEgress(egressKeys: string[]): boolean {
    return egressKeys.some((key) => this.cloudflareBlockRemainingMs(key) === 0);
  }

  canUse(webhookId: string, egressKey: string = DIRECT_EGRESS_KEY): boolean {
    // Bots use a completely different API route ("/channels/{id}/messages") that a
    // webhook-route Cloudflare ban does not touch — always exempt regardless
    // of egress key, matching the historical BOT_ prefix convention.
    const isBot = webhookId.startsWith("BOT_");
    if (!isBot && this.cloudflareBlockRemainingMs(egressKey) > 0) {
      return false;
    }
    if (this.isEgressOverBudget(egressKey)) {
      return false;
    }

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

  // --- Proactive per-egress request budget --------------------------------
  // Reactive protection (isGlobalSafe/cloudflareErrorThreshold above) only
  // notices trouble after Cloudflare has already started returning errors.
  // This tracks EVERY outbound webhook request (success or failure) per
  // egress path so the request rate can taper off — via recordEgressRequest
  // + getProactiveBackoffMs — before the ban threshold is ever reached.

  /** Call once immediately before firing a webhook request on this egress path. */
  recordEgressRequest(egressKey: string = DIRECT_EGRESS_KEY): void {
    const cutoff = Date.now() - config.egressRequestWindowMs;
    const timestamps = (this.egressRequestTimestamps.get(egressKey) ?? []).filter((t) => t > cutoff);
    timestamps.push(Date.now());
    this.egressRequestTimestamps.set(egressKey, timestamps);
  }

  /** Requests recorded for this egress path within the rolling window. */
  egressRequestCount(egressKey: string = DIRECT_EGRESS_KEY): number {
    const cutoff = Date.now() - config.egressRequestWindowMs;
    const timestamps = (this.egressRequestTimestamps.get(egressKey) ?? []).filter((t) => t > cutoff);
    this.egressRequestTimestamps.set(egressKey, timestamps);
    return timestamps.length;
  }

  /**
   * True once an egress path has used its whole proactive budget. canUse()
   * treats this the same as an active Cloudflare block — the request is
   * refused locally instead of being sent and risking an actual ban.
   */
  isEgressOverBudget(egressKey: string = DIRECT_EGRESS_KEY): boolean {
    return this.egressRequestCount(egressKey) >= config.egressRequestBudgetPerWindow;
  }

  /**
   * Backoff to sleep BEFORE the next request on this egress path. Ramps
   * smoothly from 0 once the path crosses half its budget, up to
   * baseMs + jitterMs*4 (plus random jitter) as it approaches the ceiling,
   * so throughput degrades gracefully instead of running at full speed until
   * a hard wall. Includes random jitter so many concurrent workers on the
   * same path do not re-synchronize into their own micro-bursts.
   */
  getProactiveBackoffMs(egressKey: string = DIRECT_EGRESS_KEY): number {
    const budget = config.egressRequestBudgetPerWindow;
    const halfBudget = budget / 2;
    const count = this.egressRequestCount(egressKey);
    if (count < halfBudget) return 0;

    const overHalfRatio = Math.min(1, (count - halfBudget) / halfBudget);
    const jitter = Math.random() * config.egressBackoffJitterMs;
    return Math.round(config.egressBackoffBaseMs + overHalfRatio * config.egressBackoffJitterMs * 4 + jitter);
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
