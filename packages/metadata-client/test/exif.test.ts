// The date taken from a JPEG's EXIF: DateTimeOriginal (+ its offset) first, then DateTimeDigitized and
// DateTime; both byte orders; a file without EXIF, a broken one or a non-JPEG gives null.
import { describe, expect, it } from "vitest";
import { parseExifDate, takenFromExif } from "../src/index.js";

type Tag = { tag: number; text: string };

/** A minimal JPEG: SOI, an APP0, APP1 Exif (IFD0 with `ifd0`, an Exif IFD with `exif`), SOS. */
function jpeg(ifd0: Tag[], exif: Tag[], le: boolean): Uint8Array {
  const u16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n: number) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0Entries = ifd0.length + (exif.length ? 1 : 0);
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0Entries);
  let dataAt = exifAt + (exif.length ? ifdSize(exif.length) : 0);
  const data: number[] = [];
  const entries = (tags: Tag[]) =>
    tags.flatMap((t) => {
      const bytes = [...Buffer.from(t.text + "\0", "latin1")];
      if (bytes.length <= 4) return [...u16(t.tag), ...u16(2), ...u32(bytes.length), ...bytes, ...Array(4 - bytes.length).fill(0)];
      const at = dataAt;
      dataAt += bytes.length;
      data.push(...bytes);
      return [...u16(t.tag), ...u16(2), ...u32(bytes.length), ...u32(at)];
    });
  const sorted = (tags: Tag[]) => [...tags].sort((a, b) => a.tag - b.tag);
  const e0 = entries(sorted(ifd0));
  const ptr = exif.length ? [...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt)] : [];
  const e1 = entries(sorted(exif));
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(ifd0At),
    ...u16(ifd0Entries),
    ...e0,
    ...ptr,
    ...u32(0),
    ...(exif.length ? [...u16(exif.length), ...e1, ...u32(0)] : []),
    ...data,
  ];
  const app1 = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const app0 = [0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0", "latin1"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
}

describe("date taken from EXIF", () => {
  for (const le of [true, false]) {
    it(`DateTimeOriginal with its offset wins (${le ? "little" : "big"} endian)`, () => {
      const f = jpeg([{ tag: 0x0132, text: "2024:01:01 10:00:00" }], [
        { tag: 0x9003, text: "2019:07:14 18:03:22" },
        { tag: 0x9011, text: "+02:00" },
        { tag: 0x9004, text: "2020:01:01 00:00:00" },
      ], le);
      expect(takenFromExif(f)).toBe(Date.UTC(2019, 6, 14, 16, 3, 22));
    });
  }

  it("without an offset: local time of this device", () => {
    const f = jpeg([], [{ tag: 0x9003, text: "2021:03:05 07:08:09" }], true);
    expect(takenFromExif(f)).toBe(new Date(2021, 2, 5, 7, 8, 9).getTime());
  });

  it("only DateTime in IFD0 (an edited photo): that one", () => {
    const f = jpeg([{ tag: 0x0132, text: "2018:06:01 12:00:00" }], [], false);
    expect(takenFromExif(f)).toBe(new Date(2018, 5, 1, 12).getTime());
  });

  it("a blank date, no EXIF, not a JPEG, cut short: null", () => {
    expect(takenFromExif(jpeg([], [{ tag: 0x9003, text: "0000:00:00 00:00:00" }], true))).toBeNull();
    expect(takenFromExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
    expect(takenFromExif(new TextEncoder().encode("\x89PNG\r\n\x1a\n...."))).toBeNull();
    const ok = jpeg([], [{ tag: 0x9003, text: "2019:07:14 18:03:22" }], true);
    for (let n = 0; n < ok.length - 10; n += 7) expect(() => takenFromExif(ok.subarray(0, n))).not.toThrow();
    expect(takenFromExif(ok.subarray(0, 40))).toBeNull();
  });

  it("parseExifDate: offsets, nonsense, the future", () => {
    expect(parseExifDate("2019:07:14 18:03:22", "-05:00")).toBe(Date.UTC(2019, 6, 14, 23, 3, 22));
    expect(parseExifDate("2019:13:14 18:03:22", null)).toBeNull();
    expect(parseExifDate("garbage", null)).toBeNull();
    expect(parseExifDate("2999:01:01 00:00:00", null)).toBeNull();
  });
});
