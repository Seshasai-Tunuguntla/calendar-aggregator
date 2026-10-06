import { Temporal } from 'temporal-polyfill';
import type { Interval } from './intervals.ts';

// One block of working hours in the host's local time, repeating every week.
// weekday uses ISO numbering, as Temporal does: 1 = Monday ... 7 = Sunday.
// startMinute/endMinute are minutes after local midnight; endMinute may be 1440 (end of the day).
export interface WeeklyRule {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

// Turns weekly rules into concrete UTC intervals for every local date that could overlap
// [from, to), and returns those that do, sorted by start (not merged: each interval's start is the
// anchor of its own slot grid).
//
// DST: the start and end of each rule are converted separately, so the interval has its real
// length on change days (a 01:00-04:00 rule lasts 2 hours on spring-forward day in New York and
// 4 hours on fall-back day). A rule time that falls in a spring-forward gap moves later by the size
// of the gap (Temporal's default 'compatible' disambiguation, the same as calendar apps); a repeated
// fall-back time uses its first occurrence. If that leaves an interval empty, it's dropped.
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

function atLocalMinute(date: Temporal.PlainDate, minute: number, timeZone: string): number {
  if (minute >= 24 * 60) return localDayInterval(date, timeZone).end;
  const plainTime = new Temporal.PlainTime(Math.floor(minute / 60), minute % 60);
  return date.toZonedDateTime({ timeZone, plainTime }).epochMilliseconds;
}
