// When a photo was taken, from its EXIF (JPEG): DateTimeOriginal with OffsetTimeOriginal when there is one,
// else DateTimeDigitized / DateTime. A file's modification time is often the day it was copied, not taken;
// the camera's date is what the Gallery's timeline and search by date want.
//
// Only the first bytes are needed (EXIF sits in the APP1 segment right after the start of the image); a file
// that is not a JPEG, or has no readable date, gives null and the caller keeps its fallback.

/** How many leading bytes takenFromExif looks at (APP1 is at most 64 KiB, after a few small segments). */
export const EXIF_HEAD_BYTES = 128 * 1024;

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED = 0x9012;

/**
 * The date taken in `head` (the first bytes of a JPEG), ms since the epoch, or null. A date without an
 * offset is local time of this device (as cameras write it), like the phone app does.
 */
export function takenFromExif(head: Uint8Array): number | null {
  try {
    const tiff = findExifTiff(head);
    return tiff ? dateOf(tiff) : null;
  } catch {
    return null;
  }
}

/** The TIFF block inside the JPEG's APP1 "Exif\0\0" segment. */
function findExifTiff(b: Uint8Array): DataView | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    // Fill bytes, then markers without a length.
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    // Start of scan / end of image: no EXIF before the picture data.
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (len < 2) return null;
    const start = o + 4;
    const end = Math.min(b.length, o + 2 + len);
    if (marker === 0xe1 && end - start > 14 && b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 && b[start + 3] === 0x66 && b[start + 4] === 0 && b[start + 5] === 0) {
      return new DataView(b.buffer, b.byteOffset + start + 6, end - start - 6);
    }
    o += 2 + len;
  }
  return null;
}

type Entry = { tag: number; type: number; count: number; valueAt: number };

function dateOf(v: DataView): number | null {
  if (v.byteLength < 8) return null;
  const order = v.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  if (v.getUint16(2, le) !== 42) return null;
  const ifd0 = readIfd(v, v.getUint32(4, le), le);
  const exifAt = ifd0.get(TAG_EXIF_IFD);
  const exif = exifAt ? readIfd(v, exifAt.type === 4 ? v.getUint32(exifAt.valueAt, le) : -1, le) : new Map<number, Entry>();
  const pairs: [Map<number, Entry>, number, number][] = [
    [exif, TAG_DATETIME_ORIGINAL, TAG_OFFSET_TIME_ORIGINAL],
    [exif, TAG_DATETIME_DIGITIZED, TAG_OFFSET_TIME_DIGITIZED],
    [ifd0, TAG_DATETIME, TAG_OFFSET_TIME],
  ];
  for (const [ifd, dt, off] of pairs) {
    const d = ifd.get(dt);
    if (!d) continue;
    const ms = parseExifDate(ascii(v, d), ifd.get(off) ? ascii(v, ifd.get(off)!) : exif.get(TAG_OFFSET_TIME) ? ascii(v, exif.get(TAG_OFFSET_TIME)!) : null);
    if (ms !== null) return ms;
  }
  return null;
}

function readIfd(v: DataView, at: number, le: boolean): Map<number, Entry> {
  const out = new Map<number, Entry>();
  if (at < 8 || at + 2 > v.byteLength) return out;
  const n = v.getUint16(at, le);
  for (let i = 0; i < n && i < 512; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    // ASCII (2) longer than 4 bytes is elsewhere, at the offset in the value field.
    const inline = type === 2 ? count <= 4 : true;
    out.set(v.getUint16(e, le), { tag: v.getUint16(e, le), type, count, valueAt: inline ? e + 8 : v.getUint32(e + 8, le) });
  }
  return out;
}

function ascii(v: DataView, e: Entry): string {
  if (e.type !== 2) return "";
  let s = "";
  for (let i = 0; i < e.count && i < 64; i++) {
    const at = e.valueAt + i;
    if (at >= v.byteLength) break;
    const c = v.getUint8(at);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** "2019:07:14 18:03:22" (+ "+02:00") to ms; null for blanks ("0000:00:00 00:00:00") and nonsense. */
export function parseExifDate(s: string, offset: string | null): number | null {
  const m = /^\s*(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
  const off = offset ? /^\s*([+-])(\d{2}):?(\d{2})\s*$/.exec(offset) : null;
  const ms = off
    ? Date.UTC(y, mo - 1, d, h, mi, se) - (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60_000
    : new Date(y, mo - 1, d, h, mi, se).getTime();
  // A camera with its clock never set says 1970 / 2000-01-01 at most; still a date. Refuse the future only.
  return Number.isFinite(ms) && ms > 0 && ms < Date.now() + 2 * 86_400_000 ? ms : null;
}
