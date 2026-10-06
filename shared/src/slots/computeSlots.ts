import { Temporal } from 'temporal-polyfill';
import { DAY_MS, MINUTE_MS, isCovered, mergeIntervals, subtractIntervals, type Interval } from './intervals.ts';
import { expandWeeklyRules, localDate, localDayInterval, type WeeklyRule } from './weeklyRules.ts';

export interface SlotRequest {
  /** Weekly working hours in the host's time zone. */
  rules: readonly WeeklyRule[];
  /** IANA zone, e.g. 'Asia/Kolkata'. */
  hostTimeZone: string;
  /** Busy intervals from every calendar that counts as busy; may overlap, in any order. */
  busy: readonly Interval[];
  /** The host's confirmed bookings: busy like calendar events, and counted for maxPerDay. */
  bookings: readonly Interval[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  /** Most bookings the host takes on one local day; null for no limit. */
  maxPerDay: number | null;
  durationMinutes: number;
  slotStepMinutes: number;
  /** The current time, passed in so the function stays pure and testable. */
  now: number;
  /** Only slots starting in [range.start, range.end) are returned, e.g. the week a guest is viewing. */
  range: Interval;
}

// The bookable slots for one event type, sorted by start. Pure: no clock, no I/O.
//
// 1. Expand the weekly rules into UTC working intervals (weeklyRules.ts handles the time zone).
// 2. Widen every busy interval and booking by the buffers, then sort and merge: O(n log n).
// 3. Subtract the merged busy time from the working time: one linear pass.
// 4. Walk each working interval's grid (its start + whole steps) and keep the starts whose whole
//    duration fits in one free interval (binary search: O(log f) each).
// 5. Only starts between now + minimum notice and now + horizon are generated, and starts on a
//    local day that already has maxPerDay bookings are dropped.
//
// Total: O(n log n + c log f) for n busy intervals, c grid starts in the window and f free intervals.
export function computeSlots(request: SlotRequest): Interval[] {
  assertValid(request);
  const { hostTimeZone: timeZone, now } = request;
  const duration = request.durationMinutes * MINUTE_MS;
  const step = request.slotStepMinutes * MINUTE_MS;

  // Allowed start times, both ends inclusive. Applying notice and horizon here (step 5) means
  // slots outside them are never generated, rather than generated and then removed.
  const earliest = Math.max(request.range.start, now + request.minNoticeMinutes * MINUTE_MS);
  const latest = Math.min(request.range.end - 1, now + request.horizonDays * DAY_MS);
  if (latest < earliest) return [];

  // Step 1. Up to latest + duration, so a slot starting near the end of the window can run into
  // an adjacent working interval (e.g. rules 09:00-12:00 and 12:00-17:00).
  const ruleIntervals = expandWeeklyRules(request.rules, timeZone, earliest, latest + duration);
  const working = mergeIntervals(ruleIntervals);

  // Step 2. A new slot [s, e) needs [s - bufferBefore, e + bufferAfter) clear of busy time, so
  // busy [b0, b1) blocks starts in (b0 - bufferAfter - duration, b1 + bufferBefore): the buffers
  // swap sides when they're applied to the busy interval instead of the slot.
  const before = request.bufferBeforeMinutes * MINUTE_MS;
  const after = request.bufferAfterMinutes * MINUTE_MS;
  const blocked = mergeIntervals(
    [...request.busy, ...request.bookings].map((b) => ({ start: b.start - after, end: b.end + before })),
  );

  // Step 3.
  const free = subtractIntervals(working, blocked);

  const fullDays = fullDayIntervals(request);

  // Step 4. Overlapping rules give overlapping grids, so a start can come up twice.
  const seen = new Set<number>();
  const slots: Interval[] = [];
  for (const rule of ruleIntervals) {
    const firstStep = Math.ceil((Math.max(rule.start, earliest) - rule.start) / step);
    for (let start = rule.start + firstStep * step; start < rule.end && start <= latest; start += step) {
      const end = start + duration;
      if (seen.has(start) || !isCovered(free, start, end) || isCovered(fullDays, start, start + 1)) continue;
      seen.add(start);
      slots.push({ start, end });
    }
  }
  return slots.toSorted((a, b) => a.start - b.start);
}

// The host-local days (as UTC intervals) that already have maxPerDay bookings.
function fullDayIntervals({ maxPerDay, bookings, hostTimeZone }: SlotRequest): Interval[] {
  if (maxPerDay === null) return [];

  const countByDate = new Map<string, number>();
  for (const booking of bookings) {
    const date = localDate(booking.start, hostTimeZone).toString();
    countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
  }

  const full: Interval[] = [];
  for (const [date, count] of countByDate) {
    if (count >= maxPerDay) full.push(localDayInterval(Temporal.PlainDate.from(date), hostTimeZone));
  }
  return mergeIntervals(full);
}

// The API validates requests with Zod before they get here; these checks keep the function safe
// to call from anywhere (a zero step would loop forever).
function assertValid(request: SlotRequest): void {
  const minimums = {
    durationMinutes: 1,
    slotStepMinutes: 1,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 0,
  } as const;
  for (const [name, min] of Object.entries(minimums)) {
    const value = request[name as keyof typeof minimums];
    if (!Number.isInteger(value) || value < min) {
      throw new RangeError(`${name} must be an integer of at least ${min}`);
    }
  }
  if (request.maxPerDay !== null && (!Number.isInteger(request.maxPerDay) || request.maxPerDay < 1)) {
    throw new RangeError('maxPerDay must be null or a positive integer');
  }
  for (const rule of request.rules) {
    const valid =
      Number.isInteger(rule.weekday) && rule.weekday >= 1 && rule.weekday <= 7 &&
      Number.isInteger(rule.startMinute) && Number.isInteger(rule.endMinute) &&
      rule.startMinute >= 0 && rule.startMinute < rule.endMinute && rule.endMinute <= 24 * 60;
    if (!valid) throw new RangeError(`Invalid weekly rule: ${JSON.stringify(rule)}`);
  }
}
