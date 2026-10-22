// Thumbnails and previews made in the page (browser and desktop window alike: the desktop agent has no
// image decoder, the window has Chromium's). Images: createImageBitmap (EXIF orientation applied) scaled
// on an OffscreenCanvas; videos: a <video> element seeked to 10 % of the length. Encoded as WebP (JPEG
// where the browser cannot encode WebP), quality lowered and then the size reduced until the picture
// fits its byte limit (PREVIEW_LIMITS). Anything the browser cannot decode (HEIC in Chrome, a damaged
// file, a codec it lacks) gives null: the file is uploaded without previews.
//
// Only what fits in memory comfortably is decoded: images up to IMAGE_MAX_BYTES; videos are streamed
// by the <video> element from a blob URL (the file is not read whole into memory for that).

/** Kept in sync with @ddv4/metadata-client PREVIEW_LIMITS (the page does not import the client). */
export const LIMITS = {
  t: { short: 320, longMax: 640, maxBytes: 48 * 1024 },
  p: { long: 1280, maxBytes: 400 * 1024 },
} as const;
/** Larger images are not decoded for previews (a 100 MP scan would need ~400 MB of pixels). */
export const IMAGE_MAX_BYTES = 60 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 80e6;
const VIDEO_TIMEOUT_MS = 15_000;

export interface MadeImage {
  kind: "t" | "p";
  mime: string;
  width: number;
  height: number;
  data: Uint8Array;
}

const IMAGE_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
/** Which kind of source a file name is for previews: image, video or none. */
export function previewSource(name: string): "image" | "video" | null {
  return IMAGE_EXT.test(name) ? "image" : VIDEO_EXT.test(name) ? "video" : null;
}

/** Target size of a picture of `kind` for a source of w x h (never larger than the source). */
export function fitSize(kind: "t" | "p", w: number, h: number): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  let s: number;
  if (kind === "t") {
    s = LIMITS.t.short / Math.min(w, h);
    if (Math.max(w, h) * s > LIMITS.t.longMax) s = LIMITS.t.longMax / Math.max(w, h);
  } else s = LIMITS.p.long / Math.max(w, h);
  s = Math.min(1, s);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

type Source = ImageBitmap | HTMLVideoElement;

let webpOk: Promise<boolean> | null = null;
function canWebp(): Promise<boolean> {
  webpOk ??= (async () => {
    try {
      const c = new OffscreenCanvas(2, 2);
      c.getContext("2d")!.fillRect(0, 0, 2, 2);
      return (await c.convertToBlob({ type: "image/webp", quality: 0.7 })).type === "image/webp";
    } catch {
      return false;
    }
  })();
  return webpOk;
}

/** One picture of `kind` from a decoded source, within its byte limit (null when it cannot fit). */
async function encode(src: Source, sw: number, sh: number, kind: "t" | "p"): Promise<MadeImage | null> {
  const type = (await canWebp()) ? "image/webp" : "image/jpeg";
  let { w, h } = fitSize(kind, sw, sh);
  for (let shrink = 0; shrink < 4 && w > 0; shrink++) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (type === "image/jpeg") {
      // JPEG has no alpha: transparent parts of a PNG would turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(src, 0, 0, w, h);
    for (const q of [0.7, 0.55, 0.4]) {
      const b = await c.convertToBlob({ type, quality: q });
      if (b.size <= LIMITS[kind].maxBytes) return { kind, mime: b.type || type, width: w, height: h, data: new Uint8Array(await b.arrayBuffer()) };
    }
    w = Math.max(1, Math.round(w * 0.75));
    h = Math.max(1, Math.round(h * 0.75));
  }
  return null;
}

async function both(src: Source, w: number, h: number): Promise<MadeImage[] | null> {
  const out: MadeImage[] = [];
  for (const k of ["t", "p"] as const) {
    const m = await encode(src, w, h, k);
    if (m) out.push(m);
  }
  return out.length ? out : null;
}

async function fromImage(file: Blob): Promise<MadeImage[] | null> {
  if (file.size > IMAGE_MAX_BYTES) return null;
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    if (bmp.width * bmp.height > IMAGE_MAX_PIXELS) return null;
    return await both(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

function fromVideo(file: Blob): Promise<MadeImage[] | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let done = false;
    const end = (r: MadeImage[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => end(null), VIDEO_TIMEOUT_MS);
    v.muted = true;
    v.preload = "metadata";
    v.playsInline = true;
    v.onerror = () => end(null);
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      v.currentTime = d ? Math.min(d * 0.1, Math.max(0, d - 0.1)) : 0;
    };
    v.onseeked = () => {
      if (!v.videoWidth || !v.videoHeight) return end(null);
      void both(v, v.videoWidth, v.videoHeight).then(end, () => end(null));
    };
    v.src = url;
  });
}

/**
 * Thumbnail + preview of a picked or dropped file, or null (not an image/video, cannot be decoded, too
 * big). Never throws: a failure only means the file has no previews.
 */
export async function makePreviews(file: Blob, name: string): Promise<MadeImage[] | null> {
  try {
    const k = previewSource(name);
    if (k === "image") return await fromImage(file);
    if (k === "video" && typeof document !== "undefined") return await fromVideo(file);
    return null;
  } catch {
    return null;
  }
}
