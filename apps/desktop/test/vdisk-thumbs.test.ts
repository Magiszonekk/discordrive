// Thumbnails of the disk for the file manager follow the account's "Hide thumbnail" (rules 5): a cached
// picture of a file hidden later is removed and a "hidden" marker written (the file's mtime does not change,
// so the file manager would never ask again); shown again, the marker goes. Also on a fresh session (restart).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Thumbnails, fileUri, onePixel } from "../src/vdisk-thumbs.js";

describe("disk thumbnails and the hidden-thumbnail attribute", () => {
  it("hide drops a cached picture and marks it; show drops the marker; a new session does the same", async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-vthumbs-"));
    const mp = join(base, "discordrive");
    const cacheDir = join(base, "thumbnails");
    const asked: string[] = [];
    // No stored preview: a shown file gets the plain "no thumbnail" marker (no picture conversion needed here).
    const core = { vdiskPreview: async (id: string) => (asked.push(id), null) };
    const mk = () => new Thumbnails({ helper: "/nonexistent", mountpoint: mp, core, cacheDir });
    const uri = fileUri(join(mp, "Zdjęcia", "a.jpg"));
    const entry = (thumbHidden: boolean) => [{ id: "file0001", kind: "file", mtime: 1_700_000_000_000, path: "Zdjęcia/a.jpg", thumbHidden }];
    let t = mk();
    const put = (p: string) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, onePixel()));
    const marker = () => (existsSync(t.pathOf(uri, "fail")) ? readFileSync(t.pathOf(uri, "fail")).includes(Buffer.from("thumbnail hidden")) : null);

    // The folder was open before: the picture is in the cache.
    put(t.pathOf(uri, "normal"));
    put(t.pathOf(uri, "large"));
    await t.folder(entry(false));
    expect(existsSync(t.pathOf(uri, "normal"))).toBe(true);

    // Hidden on another device: the next listing / sync drops the pictures and writes the hidden marker.
    await t.folder(entry(true));
    expect(existsSync(t.pathOf(uri, "normal"))).toBe(false);
    expect(existsSync(t.pathOf(uri, "large"))).toBe(false);
    expect(marker()).toBe(true);

    // Shown again: the hidden marker goes, the file gets its thumbnail as any other (here: none stored).
    asked.length = 0;
    await t.folder(entry(false));
    expect(asked).toEqual(["file0001"]);
    expect(marker()).toBe(false);

    // A new session (restart) with a picture still cached for a file hidden meanwhile: dropped too.
    put(t.pathOf(uri, "normal"));
    t = mk();
    await t.folder(entry(true));
    expect(existsSync(t.pathOf(uri, "normal"))).toBe(false);
    expect(marker()).toBe(true);
    // And a new session with the hidden marker of a file shown meanwhile: the marker goes.
    t = mk();
    await t.folder(entry(false));
    expect(marker()).toBe(false);
  });
});
