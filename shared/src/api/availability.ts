import { z } from 'zod';

const MINUTES_PER_DAY = 24 * 60;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// One block of weekly working hours in the host's local time.
// weekday: ISO numbering, 1 = Monday ... 7 = Sunday (the same as Temporal's dayOfWeek).
// startMinute/endMinute: minutes after local midnight; endMinute may be 1440 (end of the day).
//
// A rule never crosses midnight: 22:00-02:00 is rejected, and the host adds 22:00-24:00 on one day
// and 00:00-02:00 on the next. Storing exactly what is applied keeps each rule's slot grid
// predictable (each rule anchors its own grid), and a slot can still run across midnight between
// two touching rules.
export const weeklyRuleSchema = z
  .object({
    weekday: z.int().min(1, 'weekday must be 1 (Monday) to 7 (Sunday)').max(7, 'weekday must be 1 (Monday) to 7 (Sunday)'),
    startMinute: z.int().min(0).max(MINUTES_PER_DAY - 1),
    endMinute: z.int().min(1).max(MINUTES_PER_DAY),
  })
  .refine((rule) => rule.startMinute !== rule.endMinute, { message: 'A rule must end after it starts', path: ['endMinute'] })
  .refine((rule) => rule.startMinute <= rule.endMinute, {
    message: "A rule can't cross midnight: add one ending at 24:00 and another starting at 00:00 the next day",
    path: ['endMinute'],
  });

export type WeeklyRule = z.infer<typeof weeklyRuleSchema>;

// The first pair of rules on the same weekday that overlap, or null. Touching rules (09:00-12:00 and
// 12:00-17:00) don't overlap. Sort by weekday then start; within a weekday, a rule overlaps the
// rule before it exactly when it starts before that one ends. O(n log n).
export function findOverlappingRules(rules: readonly WeeklyRule[]): [WeeklyRule, WeeklyRule] | null {
  const sorted = rules.toSorted((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && previous.weekday === current.weekday && current.startMinute < previous.endMinute) {
      return [previous, current];
    }
  }
  return null;
}

export const weeklyRulesSchema = z
  .array(weeklyRuleSchema)
  .max(100, 'At most 100 rules')
  .superRefine((rules, ctx) => {
    const overlap = findOverlappingRules(rules);
    if (overlap) {
      const [a, b] = overlap;
      ctx.addIssue({
        code: 'custom',
        message: `${WEEKDAY_NAMES[a.weekday - 1]} ${formatMinute(a.startMinute)}-${formatMinute(a.endMinute)} overlaps ${formatMinute(b.startMinute)}-${formatMinute(b.endMinute)}`,
      });
    }
  });

// 540 -> '09:00', 1440 -> '24:00'.
export function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
