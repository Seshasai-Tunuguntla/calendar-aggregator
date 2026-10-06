import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { localParts } from '../../src/index.ts';
import { HOUR_MS, expandWeeklyRules, localDayInterval, type WeeklyRule } from '../../src/slots/index.ts';
import { IST, NY, at, utc, utcOffset } from './helpers.ts';

const rule = (weekday: number, from: string, to: string): WeeklyRule => ({
  weekday,
  startMinute: toMinute(from),
  endMinute: toMinute(to),
});

function toMinute(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const SATURDAY = 6;
const SUNDAY = 7;

describe('expandWeeklyRules', () => {
  it("converts a rule in the host's zone to UTC (India: UTC+05:30, no DST)", () => {
    const intervals = expandWeeklyRules([rule(1, '09:00', '17:00')], IST, utc('2026-10-12T00:00Z'), utc('2026-10-13T00:00Z'));
    expect(intervals).toEqual([{ start: utc('2026-10-12T03:30Z'), end: utc('2026-10-12T11:30Z') }]);
  });

  it('uses ISO weekdays: 1 is Monday and 7 is Sunday', () => {
    const week = { from: at(IST, '2026-10-12T00:00'), to: at(IST, '2026-10-19T00:00') };
    const [monday] = expandWeeklyRules([rule(1, '09:00', '10:00')], IST, week.from, week.to);
    const [sunday] = expandWeeklyRules([rule(SUNDAY, '09:00', '10:00')], IST, week.from, week.to);
    expect(localParts(monday?.start ?? 0, IST)).toMatchObject({ date: '2026-10-12', weekday: 1 });
    expect(localParts(sunday?.start ?? 0, IST)).toMatchObject({ date: '2026-10-18', weekday: 7 });
  });

  it('returns only intervals overlapping [from, to), sorted by start', () => {
    const rules = [rule(2, '14:00', '15:00'), rule(1, '09:00', '10:00'), rule(1, '13:00', '14:00'), rule(3, '09:00', '10:00')];
    const intervals = expandWeeklyRules(rules, IST, at(IST, '2026-10-12T09:30'), at(IST, '2026-10-13T14:00'));
    expect(intervals).toEqual([
      { start: at(IST, '2026-10-12T09:00'), end: at(IST, '2026-10-12T10:00') },
      { start: at(IST, '2026-10-12T13:00'), end: at(IST, '2026-10-12T14:00') },
    ]);
  });

  it('returns nothing for no rules or an empty range', () => {
    expect(expandWeeklyRules([], IST, 0, 10 * HOUR_MS)).toEqual([]);
    expect(expandWeeklyRules([rule(1, '00:00', '24:00')], IST, 5, 5)).toEqual([]);
  });

  it('ends a rule with endMinute 1440 at the next local midnight, touching a rule that starts there', () => {
    const intervals = expandWeeklyRules(
      [rule(1, '22:00', '24:00'), rule(2, '00:00', '02:00')],
      IST,
      at(IST, '2026-10-12T00:00'),
      at(IST, '2026-10-14T00:00'),
    );
    expect(intervals).toEqual([
      { start: at(IST, '2026-10-12T22:00'), end: at(IST, '2026-10-13T00:00') },
      { start: at(IST, '2026-10-13T00:00'), end: at(IST, '2026-10-13T02:00') },
    ]);
  });

  describe('DST in New York (2026: clocks go forward Sun 8 Mar, back Sun 1 Nov)', () => {
    const nineToFive = [rule(SATURDAY, '09:00', '17:00'), rule(SUNDAY, '09:00', '17:00')];

    it('09:00-17:00 is 14:00-22:00 UTC the day before spring-forward and 13:00-21:00 UTC on it', () => {
      const intervals = expandWeeklyRules(nineToFive, NY, utc('2026-03-07T00:00Z'), utc('2026-03-09T12:00Z'));
      expect(intervals).toEqual([
        { start: utc('2026-03-07T14:00Z'), end: utc('2026-03-07T22:00Z') },
        { start: utc('2026-03-08T13:00Z'), end: utc('2026-03-08T21:00Z') },
      ]);
    });

    it('09:00-17:00 is 13:00-21:00 UTC the day before fall-back and 14:00-22:00 UTC on it', () => {
      const intervals = expandWeeklyRules(nineToFive, NY, utc('2026-10-31T00:00Z'), utc('2026-11-02T12:00Z'));
      expect(intervals).toEqual([
        { start: utc('2026-10-31T13:00Z'), end: utc('2026-10-31T21:00Z') },
        { start: utc('2026-11-01T14:00Z'), end: utc('2026-11-01T22:00Z') },
      ]);
    });

    it('a rule across the change has its real length: 01:00-04:00 is 2 hours in March and 4 in November', () => {
      const night = [rule(SUNDAY, '01:00', '04:00')];
      const [march] = expandWeeklyRules(night, NY, utc('2026-03-08T00:00Z'), utc('2026-03-09T00:00Z'));
      const [november] = expandWeeklyRules(night, NY, utc('2026-11-01T00:00Z'), utc('2026-11-02T00:00Z'));
      expect(march).toEqual({ start: utc('2026-03-08T06:00Z'), end: utc('2026-03-08T08:00Z') });
      expect(november).toEqual({ start: utc('2026-11-01T05:00Z'), end: utc('2026-11-01T09:00Z') });
    });

    it('a start time in the spring-forward gap moves one hour later (02:30 does not exist; 03:30 EDT)', () => {
      const [interval] = expandWeeklyRules([rule(SUNDAY, '02:30', '05:00')], NY, utc('2026-03-08T00:00Z'), utc('2026-03-09T00:00Z'));
      expect(interval).toEqual({ start: utc('2026-03-08T07:30Z'), end: utc('2026-03-08T09:00Z') });
    });

    it('drops a rule the gap leaves empty (02:45-03:15 becomes 03:45-03:15)', () => {
      const intervals = expandWeeklyRules([rule(SUNDAY, '02:45', '03:15')], NY, utc('2026-03-08T00:00Z'), utc('2026-03-09T00:00Z'));
      expect(intervals).toEqual([]);
    });
  });

  // An independent check of the Temporal-based expansion: read every interval's start back with
  // Intl in the same zone. It must show the rule's weekday and start time, except next to a DST
  // change (where a start in a gap legitimately moves).
  it('agrees with Intl about local start times in many zones and weeks', () => {
    const zones = [IST, NY, 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/Santiago', 'UTC'];
    const rules = [rule(1, '00:00', '01:30'), rule(2, '09:15', '17:45'), rule(4, '02:30', '03:30'), rule(6, '23:00', '24:00'), rule(SUNDAY, '01:45', '06:00')];
    const weeksOf2026 = Array.from({ length: 53 }, (_, w) => utc('2026-01-01T00:00Z') + w * 7 * 24 * HOUR_MS);
    let checked = 0;
    let movedByDst = 0;
    const unexplained: string[] = [];

    for (const timeZone of zones) {
      for (const from of weeksOf2026) {
        for (const interval of expandWeeklyRules(rules, timeZone, from, from + 7 * 24 * HOUR_MS)) {
          checked++;
          const { date, weekday, time } = localParts(interval.start, timeZone);
          if (rules.some((r) => r.weekday === weekday && toMinute(time) === r.startMinute)) continue;
          if (nearOffsetChange(interval.start, timeZone)) movedByDst++;
          else unexplained.push(`${timeZone} ${date} ${time}`);
        }
      }
    }
    expect(unexplained).toEqual([]);
    expect(checked).toBeGreaterThan(8 * 53 * 4);
    // A start in a gap moves, but that's rare: a handful per zone per year.
    expect(movedByDst).toBeGreaterThan(0);
    expect(movedByDst).toBeLessThan(checked / 50);
  });
});

function hoursInNewYork(date: string): number {
  const day = localDayInterval(Temporal.PlainDate.from(date), NY);
  return (day.end - day.start) / HOUR_MS;
}

describe('localDayInterval', () => {
  it('is 24 hours on a normal day, 23 on spring-forward day and 25 on fall-back day', () => {
    expect(hoursInNewYork('2026-03-07')).toBe(24);
    expect(hoursInNewYork('2026-03-08')).toBe(23);
    expect(hoursInNewYork('2026-11-01')).toBe(25);
  });
});

// Whether the zone's UTC offset (read with Intl) differs a few hours either side of an instant.
function nearOffsetChange(epochMs: number, timeZone: string): boolean {
  return utcOffset(epochMs - 3 * HOUR_MS, timeZone) !== utcOffset(epochMs + 3 * HOUR_MS, timeZone);
}
