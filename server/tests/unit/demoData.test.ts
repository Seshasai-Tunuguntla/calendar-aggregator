import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { DEMO_HANDLE, DEMO_TRY_BOOKING_SLUG, localParts, weeklyRulesSchema } from '@calendar-aggregator/shared';
import { DEMO_CALENDARS, DEMO_EVENT_TYPES, DEMO_HOST, DEMO_RULES, DEMO_TIME_ZONE, buildDemoBusyEvents } from '../../src/demo/demoData.ts';

const MONDAY = Temporal.PlainDate.from('2026-10-12');

// The demo's events on Tuesday 13 October, as built when "today" is the given date.
const tuesdayAsBuiltOn = (today: Temporal.PlainDate) =>
  buildDemoBusyEvents(today).filter((e) => localParts(e.start, DEMO_TIME_ZONE).date === '2026-10-13');

describe('demo data', () => {
  it("has weekly rules the API would accept (no overlaps, nothing crossing midnight)", () => {
    expect(weeklyRulesSchema.safeParse(DEMO_RULES).success).toBe(true);
  });

  it("has a holiday calendar that behaves like Google's: its real id, unreadable, not counted as busy", () => {
    expect(DEMO_CALENDARS.find((c) => c.key === 'holidays')).toMatchObject({
      externalCalendarId: 'en.indian#holiday@group.v.calendar.google.com',
      busyAccess: 'UNREADABLE',
      countsAsBusy: false,
    });
    expect(DEMO_CALENDARS.filter((c) => c.busyAccess === 'READABLE').map((c) => c.name)).toEqual(['Work', 'Personal']);
  });

  it('has the booking page the sign-in page\'s "Try booking" opens', () => {
    expect(DEMO_HOST.handle).toBe(DEMO_HANDLE);
    expect(DEMO_EVENT_TYPES.map((e) => e.slug)).toContain(DEMO_TRY_BOOKING_SLUG);
  });

  it('has the three event types from the brief, with unique slugs', () => {
    expect(DEMO_EVENT_TYPES.map((e) => [e.title, e.durationMinutes])).toEqual([
      ['15-min chat', 15],
      ['30-min call', 30],
      ['60-min session', 60],
    ]);
    expect(new Set(DEMO_EVENT_TYPES.map((e) => e.slug)).size).toBe(3);
  });

  describe('buildDemoBusyEvents', () => {
    const events = buildDemoBusyEvents(MONDAY);

    it('covers the day before today through three weeks ahead, sorted', () => {
      // From a Tuesday, so the day before is a working day (Sundays have no events).
      const dates = buildDemoBusyEvents(MONDAY.add({ days: 1 })).map((e) => localParts(e.start, DEMO_TIME_ZONE).date);
      expect(dates[0]).toBe('2026-10-12');
      expect(dates.at(-1) ?? '').toBe('2026-11-03');
      expect(events.map((e) => e.start)).toEqual(events.map((e) => e.start).toSorted((a, b) => a - b));
    });

    it('gives every weekday a stand-up at 10:00 IST, so each week looks busy', () => {
      for (let day = 0; day < 21; day++) {
        const date = MONDAY.add({ days: day });
        if (date.dayOfWeek > 5) continue;
        const standUp = events.find((e) => e.calendar === 'work' && localParts(e.start, DEMO_TIME_ZONE).date === date.toString());
        expect(standUp && localParts(standUp.start, DEMO_TIME_ZONE).time, date.toString()).toBe('10:00');
      }
    });

    it('only produces valid intervals', () => {
      for (const event of events) expect(event.end).toBeGreaterThan(event.start);
    });

    it('is the same for the same date, so a reset never reshuffles a day', () => {
      expect(buildDemoBusyEvents(MONDAY)).toEqual(events);
      expect(tuesdayAsBuiltOn(MONDAY)).toEqual(tuesdayAsBuiltOn(MONDAY.add({ days: 1 })));
    });

    it('moves with "today": a reset a week later shows the following weeks', () => {
      const later = buildDemoBusyEvents(MONDAY.add({ days: 8 }));
      expect(localParts(later[0]?.start ?? 0, DEMO_TIME_ZONE).date).toBe('2026-10-19');
    });
  });
});
