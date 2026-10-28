// Day headings of the Gallery's timeline (web): busy days keep their own heading, runs of sparse days
// (one or two photos each, same month) share one, so one photo a day does not make a column of headings.
import { describe, expect, it } from "vitest";
import { galleryDayGroups } from "../../web-mo/src/gallery-days.js";

const at = (d: number, h = 12, m = 10) => new Date(2026, m - 1, d, h).getTime();

describe("Gallery day headings", () => {
  it("one photo a day for a week: one heading over a range", () => {
    const rows = [7, 6, 5, 4, 3, 2, 1].map((d) => at(d));
    const g = galleryDayGroups(rows);
    expect([...g.keys()]).toEqual([0]);
    expect(g.get(0)).toEqual({ from: at(1), to: at(7), days: 7 });
  });

  it("a busy day keeps its own heading and splits the sparse runs around it", () => {
    const rows = [at(20), at(19), at(15, 18), at(15, 12), at(15, 9), at(14), at(13, 8), at(13, 7)];
    const g = galleryDayGroups(rows);
    expect([...g.entries()]).toEqual([
      [0, { from: at(19), to: at(20), days: 2 }],
      [2, { from: at(15, 9), to: at(15, 18), days: 1 }],
      [5, { from: at(13, 7), to: at(14), days: 2 }],
    ]);
  });

  it("a run never crosses a month (the month heading comes between)", () => {
    const rows = [at(2, 12, 11), at(1, 12, 11), at(31, 12, 10), at(30, 12, 10)];
    expect([...galleryDayGroups(rows).keys()]).toEqual([0, 2]);
  });

  it("rows without a date (album cards) are skipped; ascending order (an album) works too", () => {
    const rows = [null, null, at(1), at(2), at(3, 8), at(3, 9), at(3, 10)];
    const g = galleryDayGroups(rows);
    expect([...g.entries()]).toEqual([
      [2, { from: at(1), to: at(2), days: 2 }],
      [4, { from: at(3, 8), to: at(3, 10), days: 1 }],
    ]);
  });
});
