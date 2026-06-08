import { describe, expect, it } from "vitest";
import { LEGACY_UPLOAD_CHUNK_SIZE_BYTES } from "../../lib/upload-constants.js";

describe("legacy upload chunk size", () => {
  it("uses 8 MiB chunks for the active dashboard upload path", () => {
    expect(LEGACY_UPLOAD_CHUNK_SIZE_BYTES).toBe(8 * 1024 * 1024);
  });
});
