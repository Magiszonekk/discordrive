// AI descriptions stored with a file (made by a device with the user's AI endpoint) and search over them.
// The same format as the phone (apps/android core Describe.kt): one small extra object next to the version's
// manifest, AES-256-GCM with HKDF(file key, "ddv4-file-description-v1"), AAD "ddn-description-v1", named
// HMAC(HKDF(file key, "ddv4-file-preview-name-v1"), "ddn-description:1") (base64url, 22 chars), plaintext
// JSON {v:1, description, tags[], text?, transcript?, model, at, lang}. Search: names, dates (the content's
// date when the uploader stored it, else the upload time) and descriptions; case and Polish diacritics do
// not matter; every word must match.

import { fromBase64 } from "@ddv4/processing";
import { decodeManifestRef } from "./drive-client.js";

export const DESCRIPTION_FORMAT = 1;
export const DESCRIPTION_MAX_BYTES = 64 * 1024;

export interface DescriptionRecord {
  description: string;
  tags: string[];
  text?: string;
  transcript?: string;
  model: string;
  at: number;
  lang: string;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function hkdfBits(raw: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(info) }, base, 256));
}

/** The stored name of a file's description (from the file key, base64 as in the manifestRef). */
export async function descriptionName(fileKeyB64: string): Promise<string> {
  const nk = await crypto.subtle.importKey("raw", (await hkdfBits(fromBase64(fileKeyB64), "ddv4-file-preview-name-v1")) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", nk, enc.encode(`ddn-description:${DESCRIPTION_FORMAT}`)))).slice(0, 22);
}

async function key(fileKeyB64: string, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", (await hkdfBits(fromBase64(fileKeyB64), "ddv4-file-description-v1")) as BufferSource, "AES-GCM", false, [use]);
}
const AAD = enc.encode(`ddn-description-v${DESCRIPTION_FORMAT}`);

export async function sealDescription(fileKeyB64: string, r: DescriptionRecord): Promise<Uint8Array> {
  const o = {
    v: DESCRIPTION_FORMAT,
    description: r.description.slice(0, 2000),
    tags: r.tags.slice(0, 30).map((t) => t.slice(0, 60)),
    ...(r.text ? { text: r.text.slice(0, 8000) } : {}),
    ...(r.transcript ? { transcript: r.transcript.slice(0, 20000) } : {}),
    model: r.model.slice(0, 200),
    at: r.at,
    lang: r.lang,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await key(fileKeyB64, "encrypt"), enc.encode(JSON.stringify(o))));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, 12);
  if (out.byteLength > DESCRIPTION_MAX_BYTES) throw new Error("description too large");
  return out;
}

export async function openDescription(fileKeyB64: string, data: Uint8Array): Promise<DescriptionRecord> {
  if (data.byteLength < 29 || data.byteLength > DESCRIPTION_MAX_BYTES) throw new Error("description: bad size");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) as BufferSource, additionalData: AAD }, await key(fileKeyB64, "decrypt"), data.subarray(12) as BufferSource);
  const o = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  if (o.v !== DESCRIPTION_FORMAT) throw new Error("description: unknown format");
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return {
    description: s("description") ?? "",
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
    ...(s("text") ? { text: s("text") } : {}),
    ...(s("transcript") ? { transcript: s("transcript") } : {}),
    model: s("model") ?? "",
    at: typeof o.at === "number" ? o.at : 0,
    lang: s("lang") ?? "pl",
  };
}

/** The description's name for a manifestRef (null when the reference holds no file key we know). */
export async function descriptionNameOf(manifestRef: string): Promise<{ name: string; k: string } | null> {
  try {
    const loc = decodeManifestRef(manifestRef);
    return { name: await descriptionName(loc.k), k: loc.k };
  } catch {
    return null;
  }
}

// ── search ──

/** Lowercase without diacritics ("Żółty" → "zolty"; ł → l). */
export function foldText(s: string): string {
  return s.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/\p{Mn}+/gu, "");
}

export interface SearchItem {
  id: string;
  name: string;
  /** When the content was made (or uploaded), ms; 0 = unknown. */
  date: number;
  record: DescriptionRecord | null;
}

const DATE_WORD = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Results best first: hits in the name, then exact tags, then the description, and newer first among equals.
 * A word "2024" / "2024-05" / "2024-05-17" matches the date (local time, or `tzOffsetMin` when given).
 */
export function searchItems<T extends SearchItem>(items: readonly T[], query: string, tzOffsetMin = -new Date().getTimezoneOffset()): T[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { it: T; score: number }[] = [];
  for (const it of items) {
    const name = foldText(it.name);
    const r = it.record;
    const desc = r ? foldText([r.description, r.tags.join(" "), r.text ?? "", r.transcript ?? ""].join(" ")) : "";
    const tags = r ? r.tags.map(foldText) : [];
    const day = it.date > 0 ? new Date(it.date + tzOffsetMin * 60_000) : null;
    let score = 0;
    let all = true;
    for (const w of words) {
      const d = DATE_WORD.exec(w);
      const hit = !!(d && day && day.getUTCFullYear() === Number(d[1]) && (!d[2] || day.getUTCMonth() + 1 === Number(d[2])) && (!d[3] || day.getUTCDate() === Number(d[3])));
      const inName = name.includes(w);
      const inDesc = desc.includes(w);
      if (!(hit || inName || inDesc)) {
        all = false;
        break;
      }
      score += (inName ? 3 : 0) + (tags.includes(w) ? 2 : 0) + (inDesc ? 1 : 0) + (hit ? 1 : 0);
    }
    if (all) scored.push({ it, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.it.date - a.it.date).map((x) => x.it);
}
