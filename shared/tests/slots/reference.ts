// Test-only oracle for computeSlots, plus a seeded generator of random requests.
import { Temporal } from 'temporal-polyfill';
import {
  DAY_MS,
  MINUTE_MS,
  expandWeeklyRules,
  localDate,
  type Interval,
  type SlotRequest,
  type WeeklyRule,
} from '../../src/slots/index.ts';

// Deliberately naive computeSlots. It works minute by minute with sets: no merging, no subtraction,
// no binary search, and it checks each condition directly on the raw busy intervals (so the
// buffer rule is written from the slot's side: [start - bufferBefore, end + bufferAfter) must be
// clear). Slow, but obviously correct. Inputs must be whole minutes, which the generator ensures.
//
// It shares one thing with the fast version: expandWeeklyRules, which turns local rules into UTC.
// That function has its own explicit DST tests and an independent check against Intl.
export function referenceSlots(request: SlotRequest): Interval[] {
  const { hostTimeZone: timeZone, now } = request;
  const duration = request.durationMinutes * MINUTE_MS;
  const step = request.slotStepMinutes * MINUTE_MS;
  const earliest = Math.max(request.range.start, now + request.minNoticeMinutes * MINUTE_MS);
  const latest = Math.min(request.range.end - 1, now + request.horizonDays * DAY_MS);

  // A wide, fixed margin instead of the fast version's exact window.
  const ruleIntervals = expandWeeklyRules(request.rules, timeZone, request.range.start - 2 * DAY_MS, request.range.end + 2 * DAY_MS);

  const workingMinutes = new Set<number>();
  for (const r of ruleIntervals) for (let m = r.start; m < r.end; m += MINUTE_MS) workingMinutes.add(m);

  const busyMinutes = new Set<number>();
  for (const b of [...request.busy, ...request.bookings]) for (let m = b.start; m < b.end; m += MINUTE_MS) busyMinutes.add(m);

  const bookingsPerDay = new Map<string, number>();
  for (const b of request.bookings) {
    const day = localDate(b.start, timeZone).toString();
    bookingsPerDay.set(day, (bookingsPerDay.get(day) ?? 0) + 1);
  }

  const slots = new Map<number, Interval>();
  for (const r of ruleIntervals) {
    for (let start = r.start; start < r.end; start += step) {
      const end = start + duration;
      if (start < earliest || start > latest) continue;
      if (!everyMinute(start, end, (m) => workingMinutes.has(m))) continue;
      const bufferedStart = start - request.bufferBeforeMinutes * MINUTE_MS;
      const bufferedEnd = end + request.bufferAfterMinutes * MINUTE_MS;
      if (!everyMinute(bufferedStart, bufferedEnd, (m) => !busyMinutes.has(m))) continue;
      const day = localDate(start, timeZone).toString();
      if (request.maxPerDay !== null && (bookingsPerDay.get(day) ?? 0) >= request.maxPerDay) continue;
      slots.set(start, { start, end });
    }
  }
  return [...slots.values()].toSorted((a, b) => a.start - b.start);
}

function everyMinute(from: number, to: number, test: (minute: number) => boolean): boolean {
  for (let m = from; m < to; m += MINUTE_MS) if (!test(m)) return false;
  return true;
}

// Small seeded PRNG (mulberry32) so "random" tests are reproducible: a failing seed always fails.
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Zones chosen for their awkward cases: a 30-minute DST shift (Lord Howe), 45-minute offsets
// (Kathmandu, Chatham), DST changes at midnight (Santiago), the usual US/EU changes, and none.
const ZONES = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/Santiago', 'UTC'];

const minutes = (n: number) => n * MINUTE_MS;

export function randomRequest(rand: () => number): SlotRequest {
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  // Usually put "now" up to two days before one of the zone's real DST changes in 2026 (found by
  // asking Temporal, not hard-coded), so most requests straddle one in zones that have them.
  const hostTimeZone = pick(ZONES);
  const randomDay = Date.parse('2026-01-01T00:00Z') + int(0, 364) * DAY_MS;
  const change = rand() < 0.75 ? nextOffsetChange(hostTimeZone, randomDay) : null;
  const now = (change ?? randomDay) - minutes(int(0, 2 * 24 * 60));

  const rules: WeeklyRule[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let n = rand() < 0.15 ? 0 : int(1, 2); n > 0; n--) {
      if (rand() < 0.1) {
        rules.push({ weekday, startMinute: 0, endMinute: 24 * 60 });
        continue;
      }
      const granularity = pick([5, 15, 30]);
      const startMinute = int(0, (24 * 60) / granularity - 1) * granularity;
      const endMinute = Math.min(24 * 60, startMinute + int(1, 600 / granularity) * granularity);
      rules.push({ weekday, startMinute, endMinute });
    }
  }

  const randomIntervals = (count: number, maxLengthMinutes: number) =>
    Array.from({ length: count }, () => {
      const start = now - DAY_MS + minutes(int(0, (7 * 24 * 60) / 5) * 5);
      return { start, end: start + minutes(int(1, maxLengthMinutes / 5) * 5) };
    });

  const rangeStart = now + minutes(int(-6 * 60, 12 * 60));
  return {
    rules,
    hostTimeZone,
    busy: randomIntervals(int(0, 25), 300),
    bookings: randomIntervals(int(0, 4), 90),
    bufferBeforeMinutes: pick([0, 0, 5, 10, 15, 30]),
    bufferAfterMinutes: pick([0, 0, 5, 10, 15, 30]),
    minNoticeMinutes: pick([0, 0, 0, 30, 60, 240, 600, 1440]),
    horizonDays: rand() < 0.05 ? 0 : int(1, 6),
    maxPerDay: rand() < 0.5 ? null : int(1, 3),
    durationMinutes: pick([15, 20, 30, 45, 60, 90]),
    slotStepMinutes: pick([5, 10, 15, 20, 30, 60]),
    now,
    range: { start: rangeStart, end: rangeStart + minutes(rand() < 0.05 ? int(1, 120) : int(12 * 60, 4 * 24 * 60)) },
  };
}

// The epoch ms of the zone's next UTC-offset change after `from` (within 2026), or null if none.
function nextOffsetChange(timeZone: string, from: number): number | null {
  const next = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(timeZone).getTimeZoneTransition('next');
  return next && next.year === 2026 ? next.epochMilliseconds : null;
}
