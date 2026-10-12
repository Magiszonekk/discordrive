// i18n: every key exists in both languages (web app and CLI), English texts
// have no Polish characters, placeholders match, and the language selection
// rules of the CLI (flag > env > saved config > English).
import { describe, expect, it } from "vitest";
import { en as webEn } from "../../web-mo/src/locales/en.js";
import { pl as webPl } from "../../web-mo/src/locales/pl.js";
import { CLI_DICTS, envLang } from "../src/i18n.js";

const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** Plural forms differ per language (pl has _few/_many): compare base keys. */
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");

function compare(name: string, en: Record<string, string>, pl: Record<string, string>) {
  describe(name, () => {
    it("same keys in en and pl (plural forms by base key, each with _other)", () => {
      const a = [...new Set(Object.keys(en).map(base))].sort();
      const b = [...new Set(Object.keys(pl).map(base))].sort();
      expect(b).toEqual(a);
      for (const k of Object.keys(en).filter((k) => k.endsWith("_other"))) expect(pl[k], k).toBeDefined();
      for (const k of Object.keys(pl).filter((k) => /_(one|few|many)$/.test(k))) expect(pl[base(k) + "_other"], k).toBeDefined();
    });
    it("no Polish characters in English texts", () => {
      // The bilingual language question is the one allowed exception.
      const bad = Object.entries(en).filter(([k, v]) => k !== "lang.q" && POLISH.test(v));
      expect(bad).toEqual([]);
    });
    it("no empty texts", () => {
      expect(Object.entries(en).filter(([, v]) => !v.trim())).toEqual([]);
      expect(Object.entries(pl).filter(([, v]) => !v.trim())).toEqual([]);
    });
    it("placeholders match", () => {
      const diff: string[] = [];
      for (const [k, v] of Object.entries(en)) {
        const other = pl[k] ?? pl[base(k) + "_other"];
        if (other !== undefined && JSON.stringify(placeholders(v)) !== JSON.stringify(placeholders(other))) diff.push(k);
      }
      expect(diff).toEqual([]);
    });
  });
}

compare("web app dictionary", webEn, webPl);
compare("CLI dictionary", CLI_DICTS.en, CLI_DICTS.pl);

describe("CLI language selection", () => {
  it("flag beats env; only en|pl; nothing = null (caller falls back to config, then English)", () => {
    expect(envLang("pl", {})).toBe("pl");
    expect(envLang("en", { DISCORDRIVE_LANG: "pl" })).toBe("en");
    expect(envLang(undefined, { DISCORDRIVE_LANG: "pl" })).toBe("pl");
    expect(envLang(undefined, { DISCORDRIVE_LANG: "PL_pl.UTF-8" })).toBe("pl");
    expect(envLang(undefined, { DISCORDRIVE_LANG: "de" })).toBeNull();
    expect(envLang(undefined, {})).toBeNull();
  });
});

describe("web app HTML uses only known keys", () => {
  it("every data-i18n* key in index.html exists in en", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html = readFileSync(join(__dirname, "..", "..", "web-mo", "index.html"), "utf8");
    const keys = [
      ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((p) => p.split("=")[1]!.trim())),
    ];
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => !(k in webEn))).toEqual([]);
  });
  it("every t()/tn() key used in ui.ts exists", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "web-mo", "src", "ui.ts"), "utf8");
    const used = [...src.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]!);
    const plural = [...src.matchAll(/\btn\("([\w.]+)"/g)].map((m) => m[1]!);
    expect(used.filter((k) => !(k in webEn))).toEqual([]);
    expect(plural.filter((k) => !(`${k}_other` in webEn))).toEqual([]);
  });
});
