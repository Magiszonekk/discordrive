// Encrypted thumbnails and previews of a file, made by the client that uploads it (the server never sees
// the content, so it cannot make them).
//
// Where they live: next to the file's manifest, as extra attachments of the manifest's message (Discord:
// one message, up to 10 attachments; e2ee/plain: extra blobs of the same upload on the instance). Nothing
// in the tree, the manifest or the operation log changes, so every device keeps working with them: an
// older one simply does not look at the extra attachments, a newer one finds none on older files and
// shows the file-type icon. Deleting the manifest's message deletes them too; moving a channel copies them.
//
// Names: an attachment is called HMAC(name key, kind) (base64url, 22 chars), the name key derived from the
// file key with HKDF, so neither Discord nor the instance can tell a thumbnail from a manifest by its name,
// and two devices adding the same kind to the same file pick the same name.
// Content: AES-256-GCM with the file's own preview key (HKDF of the file key, info "ddv4-file-preview-v1"),
// iv(12) || ciphertext || tag, like fragments. Plaintext: "DDPV" | version 1 | kind | width u16 | height u16 |
// mime length u8 | mime | image bytes. The kind inside is checked on reading (an attachment put under the
// other kind's name is refused).

import { fromBase64 } from "@ddv4/processing";
import type { Placement } from "./types.js";

/** Kinds: thumbnail (tiles, lists) and preview (shown first while the full picture loads). */
export type PreviewKind = "t" | "p";
export const PREVIEW_KINDS: readonly PreviewKind[] = ["t", "p"];

/**
 * Sizes (measured 2026-10-22 on 10 photos of 8-24 Mpx, Chromium canvas, WebP q0.7: thumbnail median 9 KB,
 * max 15 KB at 320 px; preview median 76 KB, max 304 KB at 1280 px).
 */
export const PREVIEW_LIMITS = {
  /** Thumbnail: the shorter side this long (a square tile is filled), the longer one at most 2x. */
  t: { short: 320, longMax: 640, maxBytes: 48 * 1024 },
  /** Preview: the longer side this long. */
  p: { long: 1280, maxBytes: 400 * 1024 },
} as const;
/** Largest preview attachment accepted when reading (a bad one is not decrypted into memory). */
export const PREVIEW_READ_MAX = 1024 * 1024;
export const PREVIEW_FORMAT_VERSION = 1;
const MAGIC = [0x44, 0x44, 0x50, 0x56]; // "DDPV"
const MIMES = new Set(["image/webp", "image/jpeg", "image/png"]);

/** One picture as the generator made it. */
export interface PreviewImage {
  kind: PreviewKind;
  mime: string;
  width: number;
  height: number;
  data: Uint8Array;
}

/** An extra attachment as stored next to a manifest: its name and where it is. */
export interface StoredExtra {
  name: string;
  size: number;
  placement: Placement;
}

/** An extra to store: name + encrypted bytes. */
export interface ExtraBlob {
  name: string;
  data: Uint8Array;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function hkdf(rootRaw: Uint8Array, info: string, alg: AesKeyGenParams | HmacImportParams, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", rootRaw as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(info) }, base, alg, false, usages);
}

/** Keys of one file's previews (from the file key, base64 as in the manifestRef). */
export interface PreviewKeys {
  key: CryptoKey;
  names: Record<PreviewKind, string>;
}

const keyCache = new Map<string, Promise<PreviewKeys>>();
export function previewKeys(fileKeyB64: string): Promise<PreviewKeys> {
  let p = keyCache.get(fileKeyB64);
  if (!p) {
    p = (async () => {
      const raw = fromBase64(fileKeyB64);
      if (raw.byteLength !== 32) throw new Error("file key must be 32 bytes");
      const key = await hkdf(raw, "ddv4-file-preview-v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
      const nk = await hkdf(raw, "ddv4-file-preview-name-v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
      const name = async (k: PreviewKind) => b64url(new Uint8Array(await crypto.subtle.sign("HMAC", nk, enc.encode(`ddn-preview:${k}`)))).slice(0, 22);
      return { key, names: { t: await name("t"), p: await name("p") } };
    })();
    keyCache.set(fileKeyB64, p);
    p.catch(() => keyCache.delete(fileKeyB64));
    if (keyCache.size > 512) keyCache.delete(keyCache.keys().next().value!);
  }
  return p;
}

/** Is this picture acceptable to store (kind, type, size, dimensions)? null = yes, else why not. */
export function checkImage(img: PreviewImage): string | null {
  if (img.kind !== "t" && img.kind !== "p") return "bad kind";
  if (!MIMES.has(img.mime)) return "bad type";
  if (!(img.data instanceof Uint8Array) || img.data.byteLength === 0) return "empty";
  if (img.data.byteLength > PREVIEW_LIMITS[img.kind].maxBytes) return "too big";
  const longest = img.kind === "t" ? PREVIEW_LIMITS.t.longMax : PREVIEW_LIMITS.p.long;
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1 || Math.max(img.width, img.height) > longest) return "bad size";
  return null;
}

/** Encrypt one picture for storage under its kind's name. */
export async function sealPreview(keys: PreviewKeys, img: PreviewImage): Promise<ExtraBlob> {
  const bad = checkImage(img);
  if (bad) throw new Error(`preview: ${bad}`);
  const mime = enc.encode(img.mime);
  const head = new Uint8Array(4 + 1 + 1 + 4 + 1 + mime.byteLength);
  head.set(MAGIC, 0);
  head[4] = PREVIEW_FORMAT_VERSION;
  head[5] = img.kind.charCodeAt(0);
  new DataView(head.buffer).setUint16(6, img.width);
  new DataView(head.buffer).setUint16(8, img.height);
  head[10] = mime.byteLength;
  head.set(mime, 11);
  const plain = new Uint8Array(head.byteLength + img.data.byteLength);
  plain.set(head, 0);
  plain.set(img.data, head.byteLength);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.key, plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, 12);
  return { name: keys.names[img.kind], data: out };
}

/** Decrypt a stored picture; throws when it is not a valid picture of `kind` for this file. */
export async function openPreview(keys: PreviewKeys, kind: PreviewKind, data: Uint8Array): Promise<PreviewImage> {
  if (data.byteLength < 12 + 16 + 12 || data.byteLength > PREVIEW_READ_MAX) throw new Error("preview: bad size");
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) as BufferSource }, keys.key, data.subarray(12) as BufferSource));
  if (MAGIC.some((b, i) => plain[i] !== b) || plain[4] !== PREVIEW_FORMAT_VERSION) throw new Error("preview: unknown format");
  if (String.fromCharCode(plain[5]!) !== kind) throw new Error("preview: other kind");
  const dv = new DataView(plain.buffer, plain.byteOffset);
  const ml = plain[10]!;
  const img: PreviewImage = { kind, width: dv.getUint16(6), height: dv.getUint16(8), mime: new TextDecoder().decode(plain.subarray(11, 11 + ml)), data: plain.slice(11 + ml) };
  // Reading accepts a little more than writing (limits may change); type and kind must match.
  if (!MIMES.has(img.mime) || img.data.byteLength === 0) throw new Error("preview: bad content");
  return img;
}

/** Which of `extras` are this file's pictures (first match per kind; a duplicate from a race is ignored). */
export function matchExtras(keys: PreviewKeys, extras: StoredExtra[]): Partial<Record<PreviewKind, StoredExtra>> {
  const out: Partial<Record<PreviewKind, StoredExtra>> = {};
  for (const k of PREVIEW_KINDS) {
    const hit = extras.find((x) => stripExt(x.name) === keys.names[k]);
    if (hit) out[k] = hit;
  }
  return out;
}

/** Attachment names carry the extension every blob gets (CORS on the CDN); the stored name is without it. */
export function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Extra-blob names the instance accepts (e2ee/plain: the blob index `x<name>`). */
export const EXTRA_NAME_RE = /^[A-Za-z0-9_-]{8,40}$/;
