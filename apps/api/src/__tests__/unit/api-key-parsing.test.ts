import { describe, it, expect } from "vitest";
import {
  parseApiKeyHeader,
  hashApiKeyAuthPart,
  LeakedApiKeyError,
  API_KEY_PREFIX,
} from "../../middleware/auth.js";

// base64url of 32 random bytes — 43 chars, and deliberately containing the
// underscore and hyphen that make base64url's alphabet awkward to split on.
const AUTH_PART = "abc-def_ghiJKLmnoPQRstuVWXyz0123456789ABCDEF";
const CRYPTO_PART = "zyx-wvu_tsrQPOnmlKJIhgfEDCBA9876543210zyxwvu";

describe("parseApiKeyHeader", () => {
  it("extracts the authPart from a correctly-presented header", () => {
    expect(parseApiKeyHeader(`${API_KEY_PREFIX}${AUTH_PART}`)).toBe(AUTH_PART);
  });

  it("keeps underscores and hyphens in the authPart intact", () => {
    // The separator is a dot precisely because base64url uses `_`; splitting on
    // `_` would truncate the secret and silently authenticate the wrong hash.
    const parsed = parseApiKeyHeader(`${API_KEY_PREFIX}${AUTH_PART}`);
    expect(parsed).toContain("_");
    expect(parsed).toContain("-");
    expect(parsed).toHaveLength(AUTH_PART.length);
  });

  it("throws when the caller sends the full secret including cryptoPart", () => {
    expect(() => parseApiKeyHeader(`${API_KEY_PREFIX}${AUTH_PART}.${CRYPTO_PART}`)).toThrow(
      LeakedApiKeyError,
    );
  });

  it("returns null for a value without our prefix", () => {
    expect(parseApiKeyHeader("some-legacy-shared-key")).toBeNull();
    expect(parseApiKeyHeader("")).toBeNull();
  });

  it("returns null for the bare prefix", () => {
    expect(parseApiKeyHeader(API_KEY_PREFIX)).toBeNull();
  });
});

describe("hashApiKeyAuthPart", () => {
  it("is deterministic and hex-encoded", () => {
    const hash = hashApiKeyAuthPart(AUTH_PART);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKeyAuthPart(AUTH_PART)).toBe(hash);
  });

  it("separates keys that share a prefix", () => {
    expect(hashApiKeyAuthPart(AUTH_PART)).not.toBe(hashApiKeyAuthPart(`${AUTH_PART}x`));
  });

  it("never hashes the cryptoPart into the stored value", () => {
    // The stored hash must depend on authPart alone, or a server compromise plus
    // the hash would narrow the search for the half that decrypts.
    expect(hashApiKeyAuthPart(AUTH_PART)).not.toBe(
      hashApiKeyAuthPart(`${AUTH_PART}.${CRYPTO_PART}`),
    );
  });
});
