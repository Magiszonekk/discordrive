// DiscorDrive v4 — Per-IP rate limiting

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const limits = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 600; // 600 req/min per IP (uploads are auth-gated)

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = limits.get(ip);

  if (!entry || now >= entry.resetAt) {
    limits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of limits) {
    if (now >= entry.resetAt) {
      limits.delete(ip);
    }
  }
}, WINDOW_MS);
