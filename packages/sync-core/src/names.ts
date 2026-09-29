// Names and name keys (rule 2).
//
// Determinism: everything here runs inside apply(), so it must give the same
// result on every JS engine. Case folding uses a pinned table
// (casefold-table.ts) instead of toLowerCase(). Unicode normalization (NFC) is
// engine-dependent, so it is NOT done during apply: clients normalize names
// when they create an operation (normalizeName) and the log carries the
// normalized name. Replicas then only fold, which is pure table lookup.

import { CASEFOLD_RUNS, CASEFOLD_SPECIAL } from "./casefold-table.js";
import type { NodeKind } from "./types.js";

let single: Map<number, number> | null = null;
let multi: Map<number, string> | null = null;

function tables(): [Map<number, number>, Map<number, string>] {
  if (!single || !multi) {
    single = new Map();
    for (let i = 0; i < CASEFOLD_RUNS.length; i += 4) {
      const start = CASEFOLD_RUNS[i]!;
      const count = CASEFOLD_RUNS[i + 1]!;
      const stride = CASEFOLD_RUNS[i + 2]!;
      const delta = CASEFOLD_RUNS[i + 3]!;
      for (let j = 0; j < count; j++) {
        const cp = start + j * stride;
        single.set(cp, cp + delta);
      }
    }
    multi = new Map(CASEFOLD_SPECIAL.map(([cp, cps]) => [cp, String.fromCodePoint(...cps)]));
  }
  return [single, multi];
}

/** Case-fold a name with the pinned table. Pure and engine-independent. */
export function foldName(name: string): string {
  let ascii = true;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    let out = "";
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : name[i];
    }
    return out;
  }
  const [s, m] = tables();
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    const sp = m.get(cp);
    if (sp !== undefined) out += sp;
    else {
      const to = s.get(cp);
      out += to === undefined ? ch : String.fromCodePoint(to);
    }
  }
  return out;
}

/** Name key used for collision checks: case-insensitive via the pinned fold. */
export const nameKey = foldName;

/**
 * Client-side normalization before a name enters an operation (NFC).
 * Never call this from apply(): NFC tables differ between engines.
 */
export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

export const MAX_NAME_LENGTH = 1024;

/** Deterministic validation (plain string checks only). Returns an error code or null. */
export function validateName(name: unknown): string | null {
  if (typeof name !== "string") return "name_not_string";
  if (name.length === 0) return "name_empty";
  if (name.length > MAX_NAME_LENGTH) return "name_too_long";
  if (name === "." || name === "..") return "name_reserved";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === 0x2f || c === 0) return "name_bad_char";
    // Lone surrogates do not survive UTF-8 encoding, so replicas would disagree.
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = name.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return "name_bad_unicode";
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return "name_bad_unicode";
  }
  return null;
}

/** Split into base and extension. Folders and dotfiles have no extension. */
export function splitExt(name: string, kind: NodeKind): [string, string] {
  if (kind === "folder") return [name, ""];
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

/** `nazwa (n).ext` (rule 2). */
export function suffixedName(name: string, kind: NodeKind, n: number): string {
  const [base, ext] = splitExt(name, kind);
  return `${base} (${n})${ext}`;
}

/** UTC, minute precision, no ':' (Windows). Deterministic: no local timezone. */
export function formatConflictDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "0000-00-00 00.00 UTC";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}.${p(d.getUTCMinutes())} UTC`;
}

/** `nazwa (konflikt, <urządzenie>, <data>).ext` (rule 7). */
export function conflictName(name: string, deviceName: string, createdAtMs: number): string {
  const [base, ext] = splitExt(name, "file");
  const dev = sanitizeLabel(deviceName) || "?";
  return `${base} (konflikt, ${dev}, ${formatConflictDate(createdAtMs)})${ext}`;
}

/** Make a free-form label usable inside a name without failing validateName. */
export function sanitizeLabel(label: string): string {
  let out = "";
  for (let i = 0; i < label.length && out.length < 64; i++) {
    const c = label.charCodeAt(i);
    if (c === 0x2f || c === 0) out += "_";
    else if (c >= 0xd800 && c <= 0xdbff) {
      const n = label.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += label[i]! + label[i + 1]!;
        i++;
      } else out += "_";
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "_";
    else out += label[i];
  }
  return out;
}
