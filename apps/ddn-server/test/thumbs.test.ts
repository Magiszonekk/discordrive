// Sizes of the thumbnails / previews the page makes (apps/web-mo/src/thumbs.ts; the encoding itself runs
// in Chromium in check.ts): never larger than the source, the thumbnail fills a square tile, a panorama is
// capped, the preview keeps the longer side; the limits match the client's.
import { describe, expect, it } from "vitest";
import { PREVIEW_LIMITS } from "@ddv4/metadata-client";
import { LIMITS, fitSize, previewSource } from "../../web-mo/src/thumbs.js";

describe("thumbnail sizes", () => {
  it("the page's limits are the client's", () => {
    expect(LIMITS).toEqual(PREVIEW_LIMITS);
  });
  it("thumbnail: shorter side 320, longer at most 640; preview: longer side 1280; never upscaled", () => {
    expect(fitSize("t", 6000, 4000)).toEqual({ w: 480, h: 320 });
    expect(fitSize("t", 4000, 6000)).toEqual({ w: 320, h: 480 });
    expect(fitSize("t", 12000, 2000)).toEqual({ w: 640, h: 107 }); // panorama
    expect(fitSize("t", 200, 100)).toEqual({ w: 200, h: 100 });
    expect(fitSize("p", 6000, 4000)).toEqual({ w: 1280, h: 853 });
    expect(fitSize("p", 1000, 700)).toEqual({ w: 1000, h: 700 });
    expect(fitSize("p", 0, 10)).toEqual({ w: 0, h: 0 });
  });
  it("sources: images and videos by name", () => {
    expect(previewSource("IMG_0001.JPG")).toBe("image");
    expect(previewSource("a.heic")).toBe("image");
    expect(previewSource("klip.webm")).toBe("video");
    expect(previewSource("notes.txt")).toBeNull();
    expect(previewSource("x.svg")).toBeNull(); // not rasterised: an SVG is shown as itself
  });
});
