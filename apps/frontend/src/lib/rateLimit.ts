// DiscorDrive v4 — Rate-limit error detection for the GraphQL client.

export const RATE_LIMIT_CODE = "RATE_LIMITED";

interface RateLimitedShape {
  extensions?: { code?: string; retryAfter?: number };
}

/**
 * Extracts the server's rate-limit retry window (seconds) from a GraphQL error.
 * graphql-request surfaces server errors as ClientError; the backend adds
 * extensions.code = "RATE_LIMITED" and extensions.retryAfter. The message
 * regex is a defensive fallback for proxies/servers that strip extensions.
 */
export function getRateLimitWaitSeconds(error: unknown): number | null {
  const candidate = error as { response?: { errors?: RateLimitedShape[] }; message?: string };

  for (const err of candidate?.response?.errors ?? []) {
    if (err?.extensions?.code === RATE_LIMIT_CODE && typeof err.extensions.retryAfter === "number") {
      return Math.max(0, Math.round(err.extensions.retryAfter));
    }
  }

  if (typeof candidate?.message === "string") {
    const match = candidate.message.match(/try again in (\d+)s/i);
    if (match) return Number(match[1]);
  }

  return null;
}

/** True when the error is a server-side rate-limit rejection. */
export function isRateLimited(error: unknown): boolean {
  return getRateLimitWaitSeconds(error) !== null;
}
