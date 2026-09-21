// DiscorDrive v4 — Per-IP and per-account rate limiting

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitPolicy {
  windowMs: number;
  maxRequests: number;
  /**
   * True for event-counted buckets (login failures): a slot is only consumed by
   * a failed attempt, so the block kicks in once the failure count reaches
   * `maxRequests` (the next attempt is refused). For request-counting policies
   * (blob/auth/challenge) exactly `maxRequests` requests are allowed and the
   * (maxRequests+1)-th is refused.
   */
  failureBased?: boolean;
}

// Named policies.
//  - "blob"       guards the high-volume binary transport endpoints.
//  - "auth"       guards low-volume credential/metadata operations (register,
//                 changePassword, refreshSession, share access).
//  - "challenge"  guards getLoginChallenge so enumerating accounts / fetching
//                 Argon2 params never eats the budget a real login needs.
//  - "login"      guards logins per IP; incremented only on a failed attempt.
//  - "loginAccount" guards logins per (account, IP); incremented only on a
//                 failed attempt and reset on success — this is the brute-force
//                 guard, so a shared/public IP can't be exhausted by unrelated
//                 accounts, and mistyping one account locks just that account.
export const RATE_LIMIT_POLICIES = {
  blob: { windowMs: 60_000, maxRequests: 300 },
  auth: { windowMs: 60_000, maxRequests: 10 },
  challenge: { windowMs: 60_000, maxRequests: 20 },
  login: { windowMs: 60_000, maxRequests: 20, failureBased: true },
  loginAccount: { windowMs: 60_000, maxRequests: 5, failureBased: true },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

const limits = new Map<string, RateLimitEntry>();

/** Rate-limited error surfaced to GraphQL clients via `extensions`. */
export class RateLimitError extends Error {
  readonly extensions: { code: string; retryAfter: number };
  constructor(retryAfter: number) {
    super(`Too many requests. Try again in ${retryAfter}s`);
    this.name = "RateLimitError";
    this.extensions = { code: "RATE_LIMITED", retryAfter };
  }
}

/** Key for a plain per-IP bucket. */
export function bucketKey(policy: RateLimitPolicyName, ip: string): string {
  return `${policy}:${ip}`;
}

/** Key for a per-(account, IP) bucket. */
export function accountBucketKey(
  policy: RateLimitPolicyName,
  identifier: string,
  ip: string,
): string {
  return `${policy}:${identifier.trim().toLowerCase()}:${ip}`;
}

/** Failure count at which the bucket starts refusing requests. */
function blockAt(policy: RateLimitPolicy): number {
  return policy.maxRequests + (policy.failureBased ? 0 : 1);
}

function countTowards(key: string, policy: RateLimitPolicy): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = limits.get(key);

  if (!entry || now >= entry.resetAt) {
    limits.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true };
  }

  entry.count++;

  if (entry.count >= blockAt(policy)) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

function peek(key: string, policy: RateLimitPolicy): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = limits.get(key);

  if (!entry || now >= entry.resetAt) {
    return { allowed: true };
  }

  if (entry.count >= blockAt(policy)) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

/**
 * Consume one slot for a request-counting policy (blob/auth/challenge).
 * Returns whether the request may proceed.
 */
export function checkRateLimit(
  ip: string,
  policyName: RateLimitPolicyName = "blob",
): { allowed: boolean; retryAfter?: number } {
  return countTowards(bucketKey(policyName, ip), RATE_LIMIT_POLICIES[policyName]);
}

/** Throwing variant of checkRateLimit for GraphQL resolvers. */
export function enforceRateLimit(ip: string, policyName: RateLimitPolicyName): void {
  const { allowed, retryAfter } = checkRateLimit(ip, policyName);
  if (!allowed) {
    throw new RateLimitError(retryAfter ?? 60);
  }
}

/**
 * Throwing, non-consuming check on an arbitrary key. Used as a pre-flight gate
 * before an operation (e.g. login) that only wants to gate, not to spend a slot
 * on a request that may then succeed and reset its bucket.
 */
export function enforceKeyRateLimit(key: string, policyName: RateLimitPolicyName): void {
  const { allowed, retryAfter } = peek(key, RATE_LIMIT_POLICIES[policyName]);
  if (!allowed) {
    throw new RateLimitError(retryAfter ?? 60);
  }
}

/** Increment a bucket on an event (e.g. a failed login). Does not throw. */
export function recordFailure(key: string, policyName: RateLimitPolicyName): void {
  countTowards(key, RATE_LIMIT_POLICIES[policyName]);
}

/** Clear a bucket (e.g. on a successful login). */
export function resetKey(key: string): void {
  limits.delete(key);
}

// Periodic cleanup of expired entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of limits) {
    if (now >= entry.resetAt) {
      limits.delete(key);
    }
  }
}, 60_000);
cleanupTimer.unref?.();