// Texts per mode (zlecenie 2026-10-13 p. 4): what the web app says must be true in its mode.
// The build resolves the dictionaries per mode (build.ts resolveTexts), so a bundle carries only
// the texts its mode shows. Plain: the server reads files and names, so no text may suggest
// end-to-end encryption or a server that cannot see the content (lint like the on* one).
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMode, resolveTexts } from "../../web-mo/build.js";
import { en } from "../../web-mo/src/locales/en.js";
import { pl } from "../../web-mo/src/locales/pl.js";

/** Phrases that claim E2EE / a blind server (EN and PL), checked on every text plain shows. */
const E2EE_CLAIMS = /end-to-end|e2ee|\bencrypt|decrypt|szyfr|server (cannot (see|read)|can't (see|read)|does not know|knows neither|never sees)|serwer (go )?nie (zna|widzi)|nie zna (go|klucza)/i;
/** The upload queue note must say what really happens in each mode. */
const QUEUE: Record<string, { en: RegExp; pl: RegExp }> = {
  "metadata-only": { en: /^Encryption and upload only run while this tab is open/, pl: /^Szyfrowanie i wysyłanie trwa tylko/ },
  e2ee: { en: /encrypted in this tab and go through the server.*Keep this tab open/, pl: /szyfrowane w tej karcie i trafiają przez serwer/ },
  plain: { en: /^Files go through the server to Discord\. Keep this tab open/, pl: /^Pliki trafiają przez serwer na Discorda/ },
};

describe("texts per mode", () => {
  for (const mode of ["metadata-only", "e2ee", "plain"] as const) {
    it(`${mode}: the queue note says what happens in this mode`, () => {
      expect(resolveTexts(en, mode)["queue.note"]).toMatch(QUEUE[mode]!.en);
      expect(resolveTexts(pl, mode)["queue.note"]).toMatch(QUEUE[mode]!.pl);
      expect(Object.keys(resolveTexts(en, mode)).some((k) => k.includes("@"))).toBe(false);
    });
  }

  it("plain: no text claims end-to-end encryption or a blind server (EN + PL)", () => {
    const bad = [...Object.entries(resolveTexts(en, "plain")), ...Object.entries(resolveTexts(pl, "plain"))].filter(([, v]) => E2EE_CLAIMS.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
  });

  it("plain bundle (built): none of those phrases and no text of another mode", async () => {
    const out = await buildMode("plain", mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-texts-")));
    const js = readdirSync(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    // Only the dictionaries' string values (code identifiers like `encryptFragment` are fine: the
    // fragments on Discord are still encrypted at rest with the file key, as in ddrive).
    const ui = readFileSync(join(out, "ui.js"), "utf8");
    const texts = [...ui.matchAll(/"([a-zA-Z]+(?:\.[a-zA-Z0-9_]+)+)": "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!.replace(/\\u([0-9a-f]{4})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))]);
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.filter(([, v]) => E2EE_CLAIMS.test(v)).map(([k, v]) => `${k}: ${v}`)).toEqual([]);
    // No dictionary key with a mode suffix left in the bundle (the build resolved them).
    expect(texts.filter(([k]) => k.includes("@"))).toEqual([]);
    expect(js).not.toMatch(/"[a-z]+\.[a-zA-Z0-9_.]+@(e2ee|plain)":/);
    expect(ui).not.toContain(resolveTexts(en, "metadata-only")["queue.note"]!);
    expect(ui).not.toContain(resolveTexts(en, "e2ee")["create.sub"]!);
  }, 120_000);

  it("e2ee: no text says the browser posts to Discord itself", () => {
    const t = resolveTexts(en, "e2ee");
    expect(t["queue.note"]).not.toMatch(/Closing the tab stops the queue\.$/);
    expect(t["hooks.secret"]).not.toMatch(/server cannot see it/);
  });
});
