// Half-open time intervals [start, end) in UTC epoch milliseconds.
//
// The slot algorithm works on plain numbers: comparing and sorting numbers is fast and can't go
// wrong with time zones. Zones only matter when the weekly rules are turned into these intervals
// (see weeklyRules.ts) and when slots are grouped by the host's local day.
export interface Interval {
  start: number;
  end: number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Sort by start, then sweep once, extending the current interval while the next one overlaps or
// touches it (next.start <= current.end): [9:00, 10:00) and [10:00, 11:00) become [9:00, 11:00).
// O(n log n) for the sort, O(n) for the sweep. Returns new objects; the input is not changed.
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .toSorted((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const next of sorted) {
    const last = merged.at(-1);
    if (last && next.start <= last.end) {
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

// `base` minus `cut`. Both must be sorted and non-overlapping (the output of mergeIntervals).
// Two pointers walk both lists once: O(n + m). A cut interval can span several base intervals, so
// the cut pointer only skips cuts that end before the current base interval starts.
export function subtractIntervals(base: readonly Interval[], cut: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let j = 0;

  for (const b of base) {
    while (j < cut.length && (cut[j]?.end ?? Infinity) <= b.start) j++;

    let cursor = b.start;
    for (let k = j; k < cut.length; k++) {
      const c = cut[k];
      if (c === undefined || c.start >= b.end || cursor >= b.end) break;
      if (c.start > cursor) result.push({ start: cursor, end: c.start });
      // Cuts are merged, so each one ends after the cursor: no Math.max needed.
      cursor = c.end;
    }
    if (cursor < b.end) result.push({ start: cursor, end: b.end });
  }
  return result;
}

// Whether one interval of a sorted, non-overlapping list fully contains [start, end).
// Binary search for the last interval starting at or before `start`: O(log n).
export function isCovered(sorted: readonly Interval[], start: number, end: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  let candidate: Interval | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = sorted[mid];
    if (interval !== undefined && interval.start <= start) {
      candidate = interval;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate !== undefined && candidate.end >= end;
}
