// '@calendar-aggregator/shared/slots': the slot algorithm. A separate entry point from the main
// package because it pulls in the Temporal polyfill (about 19 kB gzipped), which the client
// doesn't need; the client lint config forbids importing it.
export { computeSlots, type SlotRequest } from './computeSlots.ts';
export { RULE_TIME_DISAMBIGUATION, expandWeeklyRules, localDate, localDayInterval, type WeeklyRule } from './weeklyRules.ts';
export { DAY_MS, HOUR_MS, MINUTE_MS, isCovered, mergeIntervals, subtractIntervals, type Interval } from './intervals.ts';
