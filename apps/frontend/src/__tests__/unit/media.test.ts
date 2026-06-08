import { describe, expect, it } from "vitest";
import { classifyPreviewKind, deriveShareState } from "../../lib/media.js";

describe("media preview contract", () => {
  it("classifies image mime types as image preview", () => {
    expect(classifyPreviewKind("image/png")).toBe("image");
  });

  it("derives preview_available when preview is allowed for image", () => {
    expect(deriveShareState({ allowPreview: true, previewKind: "image" })).toBe("preview_available");
  });

  it("derives download_only when preview is blocked", () => {
    expect(deriveShareState({ allowPreview: false, previewKind: "image" })).toBe("download_only");
  });
});
