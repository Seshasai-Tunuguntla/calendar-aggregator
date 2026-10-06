import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, groupByDay, todayIn, zoneLabel, zoneName } from '../../src/guest/guestTime.ts';

const slot = (start: string) => ({ start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString() });

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('guest time helpers', () => {
  it("label a zone by its city and today's offset, using today's city names", () => {
    expect(zoneLabel('America/New_York', new Date('2026-10-08T12:00:00Z'))).toBe('New York (GMT-4)');
    expect(zoneLabel('America/New_York', new Date('2026-01-08T12:00:00Z'))).toBe('New York (GMT-5)');
    expect(zoneLabel('Asia/Calcutta')).toBe('Kolkata (GMT+5:30)');
    expect(zoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(zoneName('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos Aires');
  });

  it("group times by the guest's own date, so one moment can fall on different days", () => {
    // 03:30 UTC on the 13th is 23:30 on the 12th in New York, 09:00 on the 13th in Kolkata.
    const slots = [slot('2026-10-13T03:30:00.000Z'), slot('2026-10-13T14:00:00.000Z')];
    expect(groupByDay(slots, 'America/New_York').map((d) => [d.date, d.slots.length])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-13', 1],
    ]);
    expect(groupByDay(slots, 'Asia/Kolkata').map((d) => [d.date, d.slots.length])).toEqual([['2026-10-13', 2]]);
  });

  it('count dates without time zones getting in the way', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(todayIn('Pacific/Kiritimati', new Date('2026-10-06T23:00:00Z'))).toBe('2026-10-07');
    expect(todayIn('Pacific/Pago_Pago', new Date('2026-10-06T05:00:00Z'))).toBe('2026-10-05');
  });

  it('write the hour with two digits on a 24-hour clock ("04:30", not "4:30")', async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), hour12: false };
    });
    const { guestTime } = await import('../../src/guest/guestTime.ts');
    expect(guestTime('2026-10-08T08:30:00Z', 'America/New_York')).toMatch(/^04:30/);
  });

  it('leave the hour alone on a 12-hour clock ("4:30 AM")', async () => {
    const { guestTime } = await import('../../src/guest/guestTime.ts');
    expect(guestTime('2026-10-08T08:30:00Z', 'America/New_York').replace(/\s/g, ' ')).toBe('4:30 AM');
  });
});
