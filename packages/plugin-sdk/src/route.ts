// DiscorDrive v4 — Route matcher utility (shared by core and plugin registry)

/**
 * Matches a pathname against a pattern with :param segments.
 * Returns an object of captured params, or null if no match.
 *
 * matchRoute("/devices/abc", "/devices/:id") → { id: "abc" }
 * matchRoute("/devices/abc/x", "/devices/:id") → null (length mismatch)
 */
export function matchRoute(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
