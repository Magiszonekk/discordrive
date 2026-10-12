// Translations of the browser app. One dictionary per language with the same
// keys (checked by apps/ddn-server/test/i18n.test.ts). English is the default;
// the user's choice (localStorage) wins over the instance default.
//
// HTML hooks (applied by applyStatic):
//   data-i18n="key"          textContent
//   data-i18n-html="key"     innerHTML (dictionary text is trusted, may hold <b>/<strong>)
//   data-i18n-attr="placeholder=key, aria-label=key, title=key"
// Plurals: key_one / key_few / key_many / key_other, chosen by Intl.PluralRules.

import { en } from "./locales/en.js";
import { pl } from "./locales/pl.js";

export type Lang = "en" | "pl";
export const LANGS: readonly Lang[] = ["en", "pl"];
export const DICTS: Record<Lang, Record<string, string>> = { en, pl };
export const isLang = (x: unknown): x is Lang => x === "en" || x === "pl";

const STORE_KEY = "ddn.lang";
let lang: Lang = "en";

export const getLang = (): Lang => lang;
export const locale = (): string => (lang === "pl" ? "pl-PL" : "en-US");

/** Saved choice of this browser, or null. */
export function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}
export function storeLang(l: Lang): void {
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l;
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function t(key: string, params?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? DICTS.en[key];
  if (s === undefined) {
    console.warn("i18n: missing key", key);
    return key;
  }
  return fill(s, params);
}

/** Plural: `{n}` in the text is the formatted number. */
export function tn(key: string, n: number, params?: Record<string, string | number>): string {
  const cat = new Intl.PluralRules(locale()).select(n);
  const d = DICTS[lang];
  const s = d[`${key}_${cat}`] ?? d[`${key}_other`] ?? DICTS.en[`${key}_other`] ?? key;
  return fill(s, { n: fmtNum(n), ...params });
}

export const fmtNum = (n: number, digits = 0): string => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);

/** 11.4 MB (en) / 11,4 MB (pl). Binary units, as before. */
export function fmtSize(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${fmtNum(n)} B`;
  if (n < 1 << 20) return `${fmtNum(n / 1024, 1)} KB`;
  if (n < 1 << 30) return `${fmtNum(n / (1 << 20), 1)} MB`;
  return `${fmtNum(n / (1 << 30), 1)} GB`;
}

export const fmtDate = (ms: number, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string => new Date(ms).toLocaleDateString(locale(), opts);
export const fmtDateTime = (ms: number): string => new Date(ms).toLocaleString(locale());

/** Translate the static HTML (hooks above) under `root`. */
export function applyStatic(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml!)));
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.dataset.i18nAttr!.split(",")) {
      const [attr, key] = pair.split("=").map((s) => s.trim()) as [string, string];
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
  document.title = t("app.title");
}
