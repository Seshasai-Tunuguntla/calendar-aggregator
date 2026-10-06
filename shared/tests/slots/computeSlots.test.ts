import { describe, expect, it } from 'vitest';
import { localParts } from '../../src/index.ts';
import { computeSlots } from '../../src/slots/index.ts';
import { IST, MONDAY, NY, TUESDAY, at, local, slotRequest, startTimes, utc } from './helpers.ts';

const mon = (from: string, to: string) => local(IST, MONDAY, from, to);
const allDayMonday = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];

describe('computeSlots', () => {
  describe('the worked example in docs/PLAN.md', () => {
    // Priya (India), Monday 09:00-13:00, 30-minute event every 30 minutes, 4-hour notice, now 08:00.
    const example = slotRequest({
      rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 }],
      busy: [mon('09:30', '10:00'), mon('09:45', '10:30'), mon('11:30', '12:00')],
      minNoticeMinutes: 4 * 60,
      now: at(IST, `${MONDAY}T08:00`),
    });

    it('with 15-minute buffers offers only 12:30-13:00 (07:00-07:30 UTC)', () => {
      const slots = computeSlots({ ...example, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
      expect(slots).toEqual([{ start: utc('2026-10-12T07:00Z'), end: utc('2026-10-12T07:30Z') }]);
    });

    it('without buffers adds only 12:00, because the notice already rules out 09:00, 10:30 and 11:00', () => {
      expect(startTimes(computeSlots(example), IST)).toEqual(['12:00', '12:30']);
      // The same request with no notice shows what the notice removed.
      expect(startTimes(computeSlots({ ...example, minNoticeMinutes: 0 }), IST)).toEqual(['09:00', '10:30', '11:00', '12:00', '12:30']);
    });
  });

  describe('calendars', () => {
    it('with nothing busy offers every slot in working hours', () => {
      expect(startTimes(computeSlots(slotRequest()), IST)).toEqual(allDayMonday);
    });

    it('with the whole day busy offers nothing', () => {
      expect(computeSlots(slotRequest({ busy: [mon('08:00', '18:00')] }))).toEqual([]);
      expect(computeSlots(slotRequest({ busy: [mon('09:00', '17:00')] }))).toEqual([]);
    });

    it('combines overlapping and touching busy time from several calendars', () => {
      const work = [mon('10:00', '11:00')];
      const personal = [mon('10:30', '11:30'), mon('11:30', '12:00')];
      const slots = startTimes(computeSlots(slotRequest({ busy: [...personal, ...work] })), IST);
      expect(slots).toEqual(allDayMonday.filter((t) => t < '10:00' || t >= '12:00'));
    });

    it('treats confirmed bookings as busy', () => {
      const slots = startTimes(computeSlots(slotRequest({ bookings: [mon('10:00', '10:30')] })), IST);
      expect(slots).not.toContain('10:00');
      expect(slots).toContain('10:30');
    });
  });

  describe('buffers', () => {
    const meeting = [mon('10:00', '11:00')];

    it('can block a slot that would otherwise fit', () => {
      expect(startTimes(computeSlots(slotRequest({ busy: meeting })), IST)).toContain('11:00');
      const buffered = computeSlots(slotRequest({ busy: meeting, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }));
      expect(startTimes(buffered, IST)).not.toContain('11:00');
      expect(startTimes(buffered, IST)).not.toContain('09:30');
    });

    it('bufferBefore keeps a gap before a new meeting, so it blocks the slot right after busy time', () => {
      const slots = startTimes(computeSlots(slotRequest({ busy: meeting, bufferBeforeMinutes: 15 })), IST);
      expect(slots).toContain('09:30');
      expect(slots).not.toContain('11:00');
      expect(slots).toContain('11:30');
    });

    it('bufferAfter keeps a gap after a new meeting, so it blocks the slot right before busy time', () => {
      const slots = startTimes(computeSlots(slotRequest({ busy: meeting, bufferAfterMinutes: 15 })), IST);
      expect(slots).not.toContain('09:30');
      expect(slots).toContain('09:00');
      expect(slots).toContain('11:00');
    });

    it('do not shrink working hours: a slot may start at the very start of the day', () => {
      const slots = startTimes(computeSlots(slotRequest({ bufferBeforeMinutes: 30, bufferAfterMinutes: 30 })), IST);
      expect(slots).toEqual(allDayMonday);
    });
  });

  describe('working hours and the slot grid', () => {
    it('never offers an event that runs past the end of working hours', () => {
      const rules = [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }];
      expect(startTimes(computeSlots(slotRequest({ rules, durationMinutes: 45 })), IST)).toEqual(['09:00']);
      expect(startTimes(computeSlots(slotRequest({ rules, durationMinutes: 60 })), IST)).toEqual(['09:00']);
      expect(computeSlots(slotRequest({ rules, durationMinutes: 90 }))).toEqual([]);
    });

    it('starts slots on the grid of the working interval, not wherever free time begins', () => {
      const slots = computeSlots(slotRequest({ busy: [mon('09:00', '09:20')] }));
      expect(startTimes(slots, IST)[0]).toBe('09:30');
    });

    it("anchors the grid at the rule's own start", () => {
      const rules = [{ weekday: 1, startMinute: 9 * 60 + 10, endMinute: 11 * 60 }];
      expect(startTimes(computeSlots(slotRequest({ rules })), IST)).toEqual(['09:10', '09:40', '10:10']);
    });

    it('lets a slot run across two adjacent rules', () => {
      const rules = [
        { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
        { weekday: 1, startMinute: 12 * 60, endMinute: 14 * 60 },
      ];
      expect(startTimes(computeSlots(slotRequest({ rules, durationMinutes: 60 })), IST)).toContain('11:30');
    });

    it('lists a start only once when overlapping rules produce it twice', () => {
      const rules = [
        { weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 },
        { weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60 },
      ];
      const slots = computeSlots(slotRequest({ rules, durationMinutes: 60, slotStepMinutes: 60 }));
      expect(startTimes(slots, IST)).toEqual(['09:00', '10:00', '11:00']);
    });

    it('supports a step shorter than the event', () => {
      const rules = [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }];
      const slots = computeSlots(slotRequest({ rules, durationMinutes: 30, slotStepMinutes: 15 }));
      expect(startTimes(slots, IST)).toEqual(['09:00', '09:15', '09:30']);
    });

    it('returns only slots that start inside the requested range', () => {
      const slots = computeSlots(slotRequest({ range: mon('12:00', '13:00') }));
      expect(startTimes(slots, IST)).toEqual(['12:00', '12:30']);
    });
  });

  describe('minimum notice', () => {
    const now = at(IST, `${MONDAY}T08:00`);

    it('offers a slot that starts exactly at now + notice', () => {
      expect(startTimes(computeSlots(slotRequest({ now, minNoticeMinutes: 60 })), IST)[0]).toBe('09:00');
    });

    it('drops it when that is one minute, or one millisecond, too soon', () => {
      expect(startTimes(computeSlots(slotRequest({ now, minNoticeMinutes: 61 })), IST)[0]).toBe('09:30');
      expect(startTimes(computeSlots(slotRequest({ now: now + 1, minNoticeMinutes: 60 })), IST)[0]).toBe('09:30');
    });

    it('never offers slots in the past, even with no notice', () => {
      const slots = computeSlots(slotRequest({ now: at(IST, `${MONDAY}T16:10`) }));
      expect(startTimes(slots, IST)).toEqual(['16:30']);
    });
  });

  describe('booking horizon', () => {
    // Sunday 09:00 with a 1-day horizon: the last bookable start is Monday 09:00.
    const sunday9 = at(IST, '2026-10-11T09:00');

    it('offers a slot that starts exactly at now + horizon', () => {
      expect(startTimes(computeSlots(slotRequest({ now: sunday9, horizonDays: 1 })), IST)).toEqual(['09:00']);
    });

    it('drops it when it starts one millisecond later than that', () => {
      expect(computeSlots(slotRequest({ now: sunday9 - 1, horizonDays: 1 }))).toEqual([]);
    });

    it('with a 0-day horizon offers nothing: a start would have to be at or before now', () => {
      expect(computeSlots(slotRequest({ now: at(IST, `${MONDAY}T15:45`), horizonDays: 0 }))).toEqual([]);
    });
  });

  describe('max bookings per day', () => {
    const twoDays = { start: at(IST, `${MONDAY}T00:00`), end: at(IST, '2026-10-14T00:00') };
    const mondayBookings = [mon('10:00', '10:30'), mon('14:00', '14:30')];

    it('offers nothing on a day that has reached the limit, and other days stay open', () => {
      const slots = computeSlots(slotRequest({ range: twoDays, bookings: mondayBookings, maxPerDay: 2 }));
      expect(slots.map((s) => localParts(s.start, IST).date)).toEqual(Array(16).fill(TUESDAY));
    });

    it('keeps offering slots below the limit, or with no limit', () => {
      for (const maxPerDay of [3, null]) {
        const slots = computeSlots(slotRequest({ range: twoDays, bookings: mondayBookings, maxPerDay }));
        expect(slots.filter((s) => localParts(s.start, IST).date === MONDAY)).toHaveLength(14);
      }
    });

    it("counts bookings by the host's local day, not the UTC day", () => {
      // Monday 23:00 IST and Tuesday 00:15 IST are both on Monday in UTC (17:30Z and 18:45Z).
      const lateBookings = [mon('23:00', '23:30'), local(IST, TUESDAY, '00:15', '00:45')];
      const slots = computeSlots(slotRequest({ range: twoDays, bookings: lateBookings, maxPerDay: 1 }));
      expect(slots).toEqual([]);
    });
  });

  describe('time zones', () => {
    it('DST: 09:00-17:00 in New York gives the right UTC slots around 8 March 2026', () => {
      const slots = computeSlots(slotRequest({
        hostTimeZone: NY,
        rules: [6, 7].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
        now: utc('2026-03-01T00:00Z'),
        range: { start: at(NY, '2026-03-07T00:00'), end: at(NY, '2026-03-09T00:00') },
      }));
      const saturday = slots.filter((s) => s.start < utc('2026-03-08T05:00Z'));
      const sunday = slots.filter((s) => s.start >= utc('2026-03-08T05:00Z'));
      expect(saturday).toHaveLength(16);
      expect(sunday).toHaveLength(16);
      expect(saturday[0]?.start).toBe(utc('2026-03-07T14:00Z'));
      expect(sunday[0]?.start).toBe(utc('2026-03-08T13:00Z'));
      expect(sunday.at(-1)).toEqual({ start: utc('2026-03-08T20:30Z'), end: utc('2026-03-08T21:00Z') });
    });

    it('DST: 09:00-17:00 in New York gives the right UTC slots around 1 November 2026', () => {
      const slots = computeSlots(slotRequest({
        hostTimeZone: NY,
        rules: [6, 7].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
        now: utc('2026-10-25T00:00Z'),
        range: { start: at(NY, '2026-10-31T00:00'), end: at(NY, '2026-11-02T00:00') },
      }));
      const saturday = slots.filter((s) => s.start < utc('2026-11-01T04:00Z'));
      const sunday = slots.filter((s) => s.start >= utc('2026-11-01T04:00Z'));
      expect(saturday).toHaveLength(16);
      expect(sunday).toHaveLength(16);
      expect(saturday[0]?.start).toBe(utc('2026-10-31T13:00Z'));
      expect(sunday[0]?.start).toBe(utc('2026-11-01T14:00Z'));
      expect(sunday.at(-1)).toEqual({ start: utc('2026-11-01T21:30Z'), end: utc('2026-11-01T22:00Z') });
    });

    it('host in India, guest in New York: one slot reads correctly for both, even on different dates', () => {
      const slots = computeSlots(slotRequest({ range: local(IST, TUESDAY, '00:00', '23:59') }));
      const first = slots[0];
      expect(first?.start).toBe(utc('2026-10-13T03:30Z'));
      // Priya sees Tuesday 09:00; a guest in New York sees Monday 23:30 (EDT, UTC-4).
      expect(localParts(first?.start ?? 0, IST)).toEqual({ date: TUESDAY, time: '09:00', weekday: 2 });
      expect(localParts(first?.start ?? 0, NY)).toEqual({ date: MONDAY, time: '23:30', weekday: 1 });
    });
  });

  describe('input checks', () => {
    it('returns nothing when the range ends before it starts or before the notice', () => {
      expect(computeSlots(slotRequest({ range: { start: 10, end: 5 } }))).toEqual([]);
      expect(computeSlots(slotRequest({ minNoticeMinutes: 24 * 60 }))).toEqual([]);
    });

    it('rejects values that would make the result meaningless (a zero step would never finish)', () => {
      expect(() => computeSlots(slotRequest({ slotStepMinutes: 0 }))).toThrow(RangeError);
      expect(() => computeSlots(slotRequest({ durationMinutes: 2.5 }))).toThrow(RangeError);
      expect(() => computeSlots(slotRequest({ bufferAfterMinutes: -5 }))).toThrow(RangeError);
      expect(() => computeSlots(slotRequest({ maxPerDay: 0 }))).toThrow(RangeError);
      expect(() => computeSlots(slotRequest({ rules: [{ weekday: 8, startMinute: 0, endMinute: 60 }] }))).toThrow(RangeError);
      expect(() => computeSlots(slotRequest({ rules: [{ weekday: 1, startMinute: 600, endMinute: 540 }] }))).toThrow(RangeError);
    });
  });
});
