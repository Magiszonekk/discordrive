import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_POLICIES,
  RateLimitError,
  accountBucketKey,
  bucketKey,
  checkRateLimit,
  enforceKeyRateLimit,
  enforceRateLimit,
  recordFailure,
  resetKey,
} from "../../middleware/rate-limit.js";

describe("rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("allows exactly maxRequests per window for request-counting policies", () => {
    const ip = "10.0.0.1";
    const max = RATE_LIMIT_POLICIES.auth.maxRequests;
    for (let i = 0; i < max; i++) {
      expect(enforceRateLimit(ip, "auth")).toBeUndefined();
    }
    expect(() => enforceRateLimit(ip, "auth")).toThrow(RateLimitError);
  });

  it("rejects the next attempt after maxRequests login failures", () => {
    const key = accountBucketKey("loginAccount", "user@example.com", "10.0.0.2");
    const max = RATE_LIMIT_POLICIES.loginAccount.maxRequests;

    for (let i = 0; i < max; i++) {
      expect(() => enforceKeyRateLimit(key, "loginAccount")).not.toThrow();
      recordFailure(key, "loginAccount");
    }
    // maxRequests failures are allowed; the next attempt must be refused.
    expect(() => enforceKeyRateLimit(key, "loginAccount")).toThrow(RateLimitError);
  });

  it("surfaces retryAfter and RATE_LIMITED code on rejection", () => {
    const key = accountBucketKey("loginAccount", "user@example.com", "10.0.0.3");
    for (let i = 0; i < RATE_LIMIT_POLICIES.loginAccount.maxRequests; i++) {
      recordFailure(key, "loginAccount");
    }
    try {
      enforceKeyRateLimit(key, "loginAccount");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      const rle = error as RateLimitError;
      expect(rle.extensions.code).toBe("RATE_LIMITED");
      expect(rle.extensions.retryAfter).toBeGreaterThan(0);
    }
  });

  it("resets the account bucket on success without affecting the per-IP bucket", () => {
    const ip = "10.0.0.4";
    const acct = accountBucketKey("loginAccount", "user@example.com", ip);
    const loginIp = bucketKey("login", ip);

    for (let i = 0; i < RATE_LIMIT_POLICIES.loginAccount.maxRequests; i++) {
      recordFailure(acct, "loginAccount");
    }
    for (let i = 0; i < RATE_LIMIT_POLICIES.login.maxRequests; i++) {
      recordFailure(loginIp, "login");
    }

    resetKey(acct);
    expect(() => enforceKeyRateLimit(acct, "loginAccount")).not.toThrow();
    expect(() => enforceKeyRateLimit(loginIp, "login")).toThrow(RateLimitError);
  });

  it("keeps a different account on the same IP within its own account bucket", () => {
    const ip = "10.0.0.5";
    const other = accountBucketKey("loginAccount", "other@example.com", ip);
    for (let i = 0; i < RATE_LIMIT_POLICIES.loginAccount.maxRequests; i++) {
      recordFailure(accountBucketKey("loginAccount", "blocked@example.com", ip), "loginAccount");
    }
    // The blocked account is exhausted; a different account is unaffected.
    expect(() => enforceKeyRateLimit(accountBucketKey("loginAccount", "blocked@example.com", ip), "loginAccount")).toThrow(RateLimitError);
    expect(() => enforceKeyRateLimit(other, "loginAccount")).not.toThrow();
  });

  it("re-arms a failed bucket once the window expires", () => {
    const ip = "10.0.0.6";
    const key = accountBucketKey("loginAccount", "user@example.com", ip);
    for (let i = 0; i < RATE_LIMIT_POLICIES.loginAccount.maxRequests; i++) {
      recordFailure(key, "loginAccount");
    }
    expect(() => enforceKeyRateLimit(key, "loginAccount")).toThrow(RateLimitError);

    vi.advanceTimersByTime(RATE_LIMIT_POLICIES.loginAccount.windowMs + 1);
    expect(() => enforceKeyRateLimit(key, "loginAccount")).not.toThrow();
  });

  it("challenge budget is independent from the login budget", () => {
    const ip = "10.0.0.7";
    for (let i = 0; i < RATE_LIMIT_POLICIES.loginAccount.maxRequests; i++) {
      recordFailure(accountBucketKey("loginAccount", "user@example.com", ip), "loginAccount");
      recordFailure(bucketKey("login", ip), "login");
    }
    // Challenge keeps its own allowance even though login buckets are exhausted.
    for (let i = 0; i < RATE_LIMIT_POLICIES.challenge.maxRequests; i++) {
      expect(checkRateLimit(ip, "challenge").allowed).toBe(true);
    }
    expect(checkRateLimit(ip, "challenge").allowed).toBe(false);
  });
});
