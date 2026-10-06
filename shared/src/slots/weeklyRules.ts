import { Temporal } from 'temporal-polyfill';
import type { WeeklyRule } from '../api/availability.ts';
import type { Interval } from './intervals.ts';

export type { WeeklyRule };

// What a rule time means on a DST change day, when the wall clock skips it (spring forward) or
// shows it twice (fall back). 'compatible' is the rule from RFC 5545, the iCalendar standard that
// calendar apps follow: a skipped time is read with the UTC offset from before the gap, so 02:30
// on 8 Mar 2026 in New York means 03:30 EDT (07:30 UTC), and a repeated time means its first
// occurrence, so 01:30 on 1 Nov 2026 means 01:30 EDT (05:30 UTC). Following the same rule as the
// host's calendar keeps a working-hours boundary and an event at the same wall time on the same
// instant. Passed explicitly rather than relied on as Temporal's default.
export const RULE_TIME_DISAMBIGUATION = 'compatible';

// Turns weekly rules into concrete UTC intervals for every local date that could overlap
// [from, to), and returns those that do, sorted by start (not merged: each interval's start is the
// anchor of its own slot grid).
//
// DST: the start and end of each rule are converted separately, so the interval has its real
// length on change days (a 01:00-04:00 rule lasts 2 hours on spring-forward day in New York and
// 4 hours on fall-back day). Times that are skipped or repeated follow RULE_TIME_DISAMBIGUATION.
// If that leaves an interval empty (02:45-03:15 on spring-forward day), it's dropped.
export function expandWeeklyRules(
  rules: readonly WeeklyRule[],
  timeZone: string,
  from: number,
  to: number,
): Interval[] {
  if (rules.length === 0 || to <= from) return [];

  const rulesByWeekday = new Map<number, WeeklyRule[]>();
  for (const rule of rules) {
    const list = rulesByWeekday.get(rule.weekday) ?? [];
    list.push(rule);
    rulesByWeekday.set(rule.weekday, list);
  }

  // A rule ends by its own date's midnight at the latest, so dates before from's local date can't
  // overlap the range.
  let date = localDate(from, timeZone);
  const lastDate = localDate(to, timeZone);

  const intervals: Interval[] = [];
  while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
    for (const rule of rulesByWeekday.get(date.dayOfWeek) ?? []) {
      const start = atLocalMinute(date, rule.startMinute, timeZone);
      const end = atLocalMinute(date, rule.endMinute, timeZone);
      if (end > start && start < to && end > from) intervals.push({ start, end });
    }
    date = date.add({ days: 1 });
  }

  return intervals.toSorted((a, b) => a.start - b.start);
}

// The host's local calendar date at an instant, e.g. '2026-10-12' in Asia/Kolkata.
export function localDate(epochMs: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone).toPlainDate();
}

// UTC epoch ms of [startOfDay, startOfNextDay) for a local date. Usually 24 hours, but 23 or 25 on
// DST change days, which is why it's computed rather than added.
export function localDayInterval(date: Temporal.PlainDate, timeZone: string): Interval {
  return {
    start: date.toZonedDateTime({ timeZone }).epochMilliseconds,
    end: date.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds,
  };
}

// PlainDate.toZonedDateTime takes no disambiguation option (it always uses 'compatible'), so the
// conversion goes through PlainDateTime, which does.
function atLocalMinute(date: Temporal.PlainDate, minute: number, timeZone: string): number {
  if (minute >= 24 * 60) return localDayInterval(date, timeZone).end;
  const time = new Temporal.PlainTime(Math.floor(minute / 60), minute % 60);
  return date
    .toPlainDateTime(time)
    .toZonedDateTime(timeZone, { disambiguation: RULE_TIME_DISAMBIGUATION })
    .epochMilliseconds;
}
