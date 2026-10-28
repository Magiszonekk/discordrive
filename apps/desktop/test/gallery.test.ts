// The Gallery (rules 4) through the app core on Node, against a real instance server and a fake Discord:
// a space apart from the Drive (its timeline and albums; not in Files, not on the disk in the system),
// moves between the spaces, the trash and search per space, the storage totals, and the rules version on
// the wire (rules 4 only for ops that touch the Gallery; an older client stops only then).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { GALLERY_ID, ROOT_ID } from "@ddv4/sync-core";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const fake = new FakeDiscord();
const servers: DdnServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await fake.close();
});

type Wire = { rulesVersion: number; seq: number }[];
const versions = async (url: string, core: AppCore): Promise<Wire> => {
  const http = (core as unknown as { http: { json<T>(m: string, p: string): Promise<{ body: T }> } }).http;
  const r = await http.json<{ entries: { seq: number; rulesVersion: number }[] }>("GET", "/v1/log?after=0&limit=1000");
  void url;
  return r.body.entries.map((e) => ({ seq: e.seq, rulesVersion: e.rulesVersion }));
};

describe("the Gallery (a second space of the account)", () => {
  it("timeline + albums apart from the Drive; moves; trash, search, totals per space; disk shows only the Drive; rules 4 only when used", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-gallery-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "gallery test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000501").url);
    expect(await core.galleryAvailable()).toBe(true);

    // Drive work first: rules 3 on the wire (a client that cannot replay 4 still works).
    const docs = await core.mkdir("Dokumenty");
    await core.upload(new Blob([new Uint8Array(1000)]), "umowa.pdf", docs);
    const phone = await core.mkdir("Telefon – Pixel");
    const old = await core.upload(new Blob([new Uint8Array(2000)]), "IMG_0001.jpg", phone);
    const v0 = await versions(url, core);
    expect(v0.length).toBeGreaterThan(0);
    expect(v0.every((e) => e.rulesVersion === 3)).toBe(true);
    // Before anything is in it the Gallery opens empty.
    expect(core.folderPath(GALLERY_ID)).toEqual([{ id: GALLERY_ID, name: "" }]);
    expect(core.list(GALLERY_ID).rows).toEqual([]);

    // Into the Gallery: a photo without an album, an album with two (dates taken: newest first).
    const f = (name: string, at: number, n: number) => new File([new Uint8Array(n)], name, { lastModified: at });
    const p1 = await core.upload(f("IMG_A.jpg", Date.UTC(2024, 4, 1), 3000), "IMG_A.jpg", GALLERY_ID);
    const album = await core.mkdir("Wakacje", GALLERY_ID);
    const p2 = await core.upload(f("IMG_B.jpg", Date.UTC(2025, 6, 10), 4000), "IMG_B.jpg", album);
    const p3 = await core.upload(f("IMG_C.jpg", Date.UTC(2023, 1, 2), 5000), "IMG_C.jpg", album);
    const v1 = (await versions(url, core)).slice(v0.length);
    expect(v1.length).toBeGreaterThan(0);
    // upload_begin of a Gallery upload is no Gallery op (no node yet), the commit + create is.
    expect(v1.filter((e) => e.rulesVersion === 4).length).toBeGreaterThanOrEqual(4);

    // The Gallery's root: albums first, then every photo of the space (albums too), newest first.
    const g = core.list(GALLERY_ID);
    expect(g.rows.map((r) => r.name)).toEqual(["Wakacje", "IMG_B.jpg", "IMG_A.jpg", "IMG_C.jpg"]);
    expect(g.total).toBe(4);
    expect(g.rows[1]!.modifiedAt).toBe(Date.UTC(2025, 6, 10));
    // Keyset pages of 2 = the same order.
    const pg1 = core.list(GALLERY_ID, undefined, 2);
    const pg2 = core.list(GALLERY_ID, pg1.rows.at(-1)!.cursor, 2);
    expect([...pg1.rows, ...pg2.rows].map((r) => r.id)).toEqual(g.rows.map((r) => r.id));
    expect(core.folderStats(GALLERY_ID)).toEqual({ folders: 1, files: 3, bytes: 12000 });
    // In an album sorted by date: by the date taken too (both directions), sub-folders first.
    expect(core.list(album, undefined, 50, { by: "date", desc: true }).rows.map((r) => r.name)).toEqual(["IMG_B.jpg", "IMG_C.jpg"]);
    expect(core.list(album, undefined, 50, { by: "date", desc: false }).rows.map((r) => [r.name, r.modifiedAt])).toEqual([["IMG_C.jpg", Date.UTC(2023, 1, 2)], ["IMG_B.jpg", Date.UTC(2025, 6, 10)]]);
    // Album cards in one call: count and the newest photo by date taken as the cover; Drive folders are not albums.
    expect(core.albumCovers([album, docs])).toEqual({ [album]: { n: 2, cover: { id: p2.nodeId, at: Date.UTC(2025, 6, 10) } } });
    expect(core.folderPath(album)).toEqual([{ id: GALLERY_ID, name: "" }, { id: album, name: "Wakacje" }]);
    // The Drive does not show the Gallery.
    expect(core.list(ROOT_ID).rows.map((r) => r.name).sort()).toEqual(["Dokumenty", "Telefon – Pixel"]);

    // Search is per space.
    expect((await core.search("IMG", "gallery")).map((h) => h.name).sort()).toEqual(["IMG_A.jpg", "IMG_B.jpg", "IMG_C.jpg"]);
    expect((await core.search("IMG", "drive")).map((h) => h.name)).toEqual(["IMG_0001.jpg"]);

    // The disk in the system: only the Drive (a Gallery ID from a stale placeholder is not there either).
    expect(core.vdiskList("root")!.map((e) => e.name).sort()).toEqual(["Dokumenty", "Telefon – Pixel"]);
    expect(core.vdiskList(album)).toBeNull();
    expect(core.vdiskStat(p2.nodeId)).toBeNull();
    expect(core.vdiskPath(album)).toBeNull();
    await core.vdiskTrash(p2.nodeId);
    expect(core.list(album).rows.length).toBe(2);

    // Storage: the Gallery's share of all files.
    const st = await core.storageTotals();
    expect(st.files).toBe(5);
    expect(st.galleryFiles).toBe(3);
    expect(st.galleryBytes).toBe(12000);

    // Move an old copy from the Drive to the Gallery and a photo back (plain moves).
    await core.move([old.nodeId], album);
    expect(core.list(album).rows.map((r) => r.name).sort()).toEqual(["IMG_0001.jpg", "IMG_B.jpg", "IMG_C.jpg"]);
    expect((await core.search("IMG_0001", "drive")).length).toBe(0);
    await core.move([p1.nodeId], phone);
    expect(core.list(phone).rows.map((r) => r.name)).toEqual(["IMG_A.jpg"]);
    expect(core.vdiskList(phone)!.map((e) => e.name)).toEqual(["IMG_A.jpg"]);

    // One trash for the account; a row knows its space, restore goes back there.
    await core.trash([p3.nodeId]);
    const tr = core.trashList().find((x) => x.id === p3.nodeId)!;
    expect(tr.space).toBe("gallery");
    expect(tr.from).toEqual(["Wakacje"]);
    expect(core.trashList().find((x) => x.id === p3.nodeId)).toBeDefined();
    await core.restore([p3.nodeId]);
    expect(core.list(album).rows.some((r) => r.id === p3.nodeId)).toBe(true);

    // A second device (paired): the same timeline, dates taken from the manifests (not when it synced).
    const b = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data-b") }));
    const offer = await b.pairStart(url, "second device");
    const accepted = core.pairAccept(offer.offer);
    let sas: { sas: string } | null = null;
    for (let i = 0; i < 100 && !sas; i++) {
      sas = await b.pairPoll();
      if (!sas) await new Promise((r) => setTimeout(r, 100));
    }
    expect(sas).not.toBeNull();
    await accepted;
    await b.pairConfirm();
    await b.open();
    const want = core.list(GALLERY_ID).rows.map((r) => [r.name, r.modifiedAt]);
    b.list(GALLERY_ID); // starts the look at the manifests
    let got: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      got = b.list(GALLERY_ID).rows.map((r) => [r.name, r.modifiedAt]);
      if (JSON.stringify(got) === JSON.stringify(want)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(got).toEqual(want);
    expect(want.find((x) => x[0] === "IMG_C.jpg")![1]).toBe(Date.UTC(2023, 1, 2));
    b.close();

    // After all that, Drive-only work still goes out as rules 3.
    const before = (await versions(url, core)).length;
    await core.rename(docs, "Dokumenty 2026");
    const after = (await versions(url, core)).slice(before);
    expect(after.map((e) => e.rulesVersion)).toEqual([3]);
  }, 120_000);
  it("a JPEG copied today is placed by the camera's date in its EXIF, not by the file's modification time", async () => {
    const origin = await fake.listen();
    const srv = new DdnServer({ rateLimits: false, signup: "open" });
    servers.push(srv);
    const { url } = await srv.listen(0);
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-gallery-exif-"));
    const core = new AppCore({ discordApiOrigin: origin }, nodePlatform({ dataDir: join(base, "data") }));
    await core.createAccount(url, "gallery exif");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000502").url);
    // SOI, APP1 "Exif" with IFD0 DateTime = 2019:07:14 18:03:22 (big endian), start of scan, end.
    const date = [...Buffer.from("2019:07:14 18:03:22\0", "latin1")];
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x32, 0, 2, 0, 0, 0, date.length, 0, 0, 0, 26, 0, 0, 0, 0, ...date];
    const app1 = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, app1.length + 2, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    const today = Date.now();
    await core.upload(new File([jpg], "old.jpg", { lastModified: today }), "old.jpg", GALLERY_ID);
    await core.upload(new File([new Uint8Array(500)], "new.png", { lastModified: today - 1000 }), "new.png", GALLERY_ID);
    const rows = core.list(GALLERY_ID).rows.map((r) => [r.name, r.modifiedAt]);
    expect(rows).toEqual([
      ["new.png", today - 1000],
      ["old.jpg", new Date(2019, 6, 14, 18, 3, 22).getTime()],
    ]);
  }, 60_000);
});
