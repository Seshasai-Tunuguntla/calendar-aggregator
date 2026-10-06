import { describe, expect, it } from 'vitest';
import { findOverlappingRules, formatMinute, weeklyRuleSchema, weeklyRulesSchema, type WeeklyRule } from '../../src/index.ts';

const rule = (weekday: number, from: string, to: string): WeeklyRule => ({
  weekday,
  startMinute: toMinute(from),
  endMinute: toMinute(to),
});

function toMinute(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function firstError(input: unknown): string | undefined {
  const result = weeklyRulesSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('weeklyRuleSchema', () => {
  it('accepts a normal rule and one that ends at 24:00', () => {
    expect(weeklyRuleSchema.parse(rule(1, '09:00', '17:00'))).toEqual(rule(1, '09:00', '17:00'));
    expect(weeklyRuleSchema.safeParse(rule(5, '22:00', '24:00')).success).toBe(true);
  });

  it('rejects a rule that crosses midnight, and says how to enter it instead', () => {
    const result = weeklyRuleSchema.safeParse(rule(1, '22:00', '02:00'));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "A rule can't cross midnight: add one ending at 24:00 and another starting at 00:00 the next day",
    );
  });

  it('rejects an empty rule', () => {
    expect(weeklyRuleSchema.safeParse(rule(1, '09:00', '09:00')).error?.issues[0]?.message).toBe('A rule must end after it starts');
  });

  it('rejects weekdays outside 1-7, minutes outside the day, and fractions', () => {
    expect(weeklyRuleSchema.safeParse(rule(0, '09:00', '10:00')).success).toBe(false);
    expect(weeklyRuleSchema.safeParse(rule(8, '09:00', '10:00')).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ weekday: 1, startMinute: -1, endMinute: 60 }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ weekday: 1, startMinute: 0, endMinute: 1441 }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ weekday: 1, startMinute: 1440, endMinute: 1440 }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ weekday: 1, startMinute: 9.5, endMinute: 60 }).success).toBe(false);
  });
});

describe('weeklyRulesSchema', () => {
  it('accepts touching rules on the same weekday', () => {
    expect(firstError([rule(1, '09:00', '12:00'), rule(1, '12:00', '17:00')])).toBeUndefined();
  });

  it('accepts the same hours on different weekdays', () => {
    expect(firstError([rule(1, '09:00', '17:00'), rule(2, '09:00', '17:00')])).toBeUndefined();
  });

  it('accepts a night split into two rules across midnight', () => {
    expect(firstError([rule(1, '22:00', '24:00'), rule(2, '00:00', '02:00')])).toBeUndefined();
  });

  it('rejects overlapping rules on the same weekday, naming both', () => {
    expect(firstError([rule(1, '09:00', '12:00'), rule(1, '11:00', '14:00')])).toBe('Monday 09:00-12:00 overlaps 11:00-14:00');
  });

  it('rejects a rule inside another, and an exact duplicate', () => {
    expect(firstError([rule(3, '09:00', '17:00'), rule(3, '10:00', '11:00')])).toBe('Wednesday 09:00-17:00 overlaps 10:00-11:00');
    expect(firstError([rule(7, '09:00', '10:00'), rule(7, '09:00', '10:00')])).toBe('Sunday 09:00-10:00 overlaps 09:00-10:00');
  });

  it('finds an overlap whatever order the rules come in', () => {
    expect(firstError([rule(2, '13:00', '15:00'), rule(1, '09:00', '10:00'), rule(2, '08:00', '13:30')])).toBe(
      'Tuesday 08:00-13:30 overlaps 13:00-15:00',
    );
  });

  it('accepts no rules at all (a host can pause bookings)', () => {
    expect(firstError([])).toBeUndefined();
  });
});

describe('findOverlappingRules', () => {
  it('returns null for touching rules and the overlapping pair otherwise', () => {
    expect(findOverlappingRules([rule(1, '09:00', '12:00'), rule(1, '12:00', '17:00')])).toBeNull();
    expect(findOverlappingRules([rule(1, '12:00', '17:00'), rule(1, '09:00', '12:01')])).toEqual([
      rule(1, '09:00', '12:01'),
      rule(1, '12:00', '17:00'),
    ]);
  });
});

describe('formatMinute', () => {
  it('formats minutes after midnight as HH:mm, including the end of the day', () => {
    expect(formatMinute(0)).toBe('00:00');
    expect(formatMinute(545)).toBe('09:05');
    expect(formatMinute(1440)).toBe('24:00');
  });
});
