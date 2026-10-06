import { Temporal } from 'temporal-polyfill';
import { localParts } from '../../src/index.ts';
import type { Interval, SlotRequest } from '../../src/slots/index.ts';

export const IST = 'Asia/Kolkata';
export const NY = 'America/New_York';

// UTC epoch ms of a wall-clock time in a zone: at(IST, '2026-10-12T09:30').
export function at(timeZone: string, localDateTime: string): number {
  return Temporal.PlainDateTime.from(localDateTime).toZonedDateTime(timeZone).epochMilliseconds;
}

// A [start, end) interval given as two local wall-clock times on one date.
export function local(timeZone: string, date: string, from: string, to: string): Interval {
  return { start: at(timeZone, `${date}T${from}`), end: at(timeZone, `${date}T${to}`) };
}

// Slot starts as 'HH:mm' in a zone, so assertions read like a calendar.
export function startTimes(slots: readonly Interval[], timeZone: string): string[] {
  return slots.map((slot) => localParts(slot.start, timeZone).time);
}

// A zone's UTC offset (ms) at an instant, read with Intl, so tests can check Temporal-based code
// against an independent source.
export function utcOffset(epochMs: number, timeZone: string): number {
  const { date, time } = localParts(epochMs, timeZone);
  return Date.parse(`${date}T${time}:00Z`) - Math.floor(epochMs / 60_000) * 60_000;
}

export function utc(iso: string): number {
  return Date.parse(iso);
}

export const MONDAY = '2026-10-12';
export const TUESDAY = '2026-10-13';

const weekdays9to5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

// A plain request: Priya in India, Mon-Fri 09:00-17:00, 30-minute slots every 30 minutes, nothing
// busy, no buffers or notice, looking at Monday 12 Oct 2026 from Monday midnight.
export function slotRequest(overrides: Partial<SlotRequest> = {}): SlotRequest {
  return {
    rules: weekdays9to5,
    hostTimeZone: IST,
    busy: [],
    bookings: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 30,
    maxPerDay: null,
    durationMinutes: 30,
    slotStepMinutes: 30,
    now: at(IST, `${MONDAY}T00:00`),
    range: { start: at(IST, `${MONDAY}T00:00`), end: at(IST, `${TUESDAY}T00:00`) },
    ...overrides,
  };
}
