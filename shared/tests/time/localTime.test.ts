import { describe, expect, it } from 'vitest';
import { localParts } from '../../src/index.ts';

const utc = (iso: string) => Date.parse(iso);

describe('localParts', () => {
  it('reads an instant in India (+05:30) and New York (EDT, -04:00)', () => {
    const instant = utc('2026-10-12T07:00Z');
    expect(localParts(instant, 'Asia/Kolkata')).toEqual({ date: '2026-10-12', time: '12:30', weekday: 1 });
    expect(localParts(instant, 'America/New_York')).toEqual({ date: '2026-10-12', time: '03:00', weekday: 1 });
  });

  it('shows a different date when the zones are on opposite sides of midnight', () => {
    const instant = utc('2026-10-13T03:30Z');
    expect(localParts(instant, 'Asia/Kolkata')).toEqual({ date: '2026-10-13', time: '09:00', weekday: 2 });
    expect(localParts(instant, 'America/New_York')).toEqual({ date: '2026-10-12', time: '23:30', weekday: 1 });
  });

  it('uses a 24-hour clock with 00 for midnight (never 24:00)', () => {
    expect(localParts(utc('2026-10-12T00:00Z'), 'UTC').time).toBe('00:00');
    expect(localParts(utc('2026-10-12T23:59Z'), 'UTC').time).toBe('23:59');
  });

  it('handles 45-minute offsets (Kathmandu, +05:45)', () => {
    expect(localParts(utc('2026-10-12T03:15Z'), 'Asia/Kathmandu').time).toBe('09:00');
  });

  it('numbers weekdays from Monday = 1 to Sunday = 7', () => {
    expect(localParts(utc('2026-10-18T12:00Z'), 'UTC').weekday).toBe(7);
    expect(localParts(utc('2026-10-19T12:00Z'), 'UTC').weekday).toBe(1);
  });

  it('throws for an unknown time zone', () => {
    expect(() => localParts(0, 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
