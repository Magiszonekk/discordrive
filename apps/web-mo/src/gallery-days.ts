// Day headings of the Gallery's timeline. A day with several photos gets its own heading; consecutive days
// with only one or two photos (in the same month) share one heading with the date range, so sparse photos
// fill a row of tiles instead of a column of headings with one tile under each.

/** Days with fewer photos than this get no heading of their own. */
export const GALLERY_SPARSE_DAY = 3;

export interface DayGroup {
  /** The oldest and the newest photo of the group, ms. */
  from: number;
  to: number;
  /** How many days it spans (1 = a single day: its own heading). */
  days: number;
}

/**
 * For the timeline's rows in order (`at` = the date taken, null for rows that are not dated photos): per row
 * index that starts a group, the group. Days are counted over the rows given (one page of the timeline).
 */
export function galleryDayGroups(at: readonly (number | null)[], sparse = GALLERY_SPARSE_DAY): Map<number, DayGroup> {
  const dayKey = (ms: number) => new Date(ms).toDateString();
  const monthKey = (ms: number) => `${new Date(ms).getFullYear()}-${new Date(ms).getMonth()}`;
  const perDay = new Map<string, number>();
  for (const ms of at) if (ms) perDay.set(dayKey(ms), (perDay.get(dayKey(ms)) ?? 0) + 1);
  const out = new Map<number, DayGroup>();
  let open: (DayGroup & { month: string; sparse: boolean; day: string }) | null = null;
  at.forEach((ms, i) => {
    if (!ms) return;
    const day = dayKey(ms);
    const month = monthKey(ms);
    const isSparse = (perDay.get(day) ?? 0) < sparse;
    const sameDay = open?.day === day;
    if (open && (sameDay || (open.sparse && isSparse && open.month === month))) {
      open.from = Math.min(open.from, ms);
      open.to = Math.max(open.to, ms);
      if (!sameDay) ((open.days += 1), (open.day = day));
      return;
    }
    open = { from: ms, to: ms, days: 1, month, sparse: isSparse, day };
    out.set(i, open);
  });
  return new Map([...out].map(([i, g]) => [i, { from: g.from, to: g.to, days: g.days }]));
}
