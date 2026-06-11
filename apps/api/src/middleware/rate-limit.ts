// DiscorDrive v4 — Per-IP rate limiting

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitPolicy {
  windowMs: number;
  maxRequests: number;
}

// Named policies. "auth" guards credential-related operations (login, register,
// challenge fetch, password change, share access) against brute force and
// enumeration. "blob" guards the high-volume binary transport endpoints.
export const RATE_LIMIT_POLICIES = {
  blob: { windowMs: 60_000, maxRequests: 300 },
  auth: { windowMs: 60_000, maxRequests: 10 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

const limits = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  ip: string,
  policyName: RateLimitPolicyName = "blob",
): { allowed: boolean; retryAfter?: number } {
  const policy = RATE_LIMIT_POLICIES[policyName];
  const key = `${policyName}:${ip}`;
  const now = Date.now();
  const entry = limits.get(key);

  if (!entry || now >= entry.resetAt) {
    limits.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true };
  }

  entry.count++;

  if (entry.count > policy.maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

// Throwing variant for GraphQL resolvers.
export function enforceRateLimit(ip: string, policyName: RateLimitPolicyName): void {
  const { allowed, retryAfter } = checkRateLimit(ip, policyName);
  if (!allowed) {
    throw new Error(`Too many requests. Try again in ${retryAfter ?? 60}s`);
  }
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
