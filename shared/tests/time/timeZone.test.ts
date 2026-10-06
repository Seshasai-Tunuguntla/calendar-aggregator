import { describe, expect, it } from 'vitest';
import { isValidTimeZone, timeZoneSchema } from '../../src/index.ts';

describe('isValidTimeZone', () => {
  it('accepts IANA zone names, including multi-part ones and UTC', () => {
    for (const zone of ['Asia/Kolkata', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'UTC']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it('rejects fixed offsets, which ignore DST, even though Intl accepts them', () => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: '+05:30' })).not.toThrow();
    expect(isValidTimeZone('+05:30')).toBe(false);
    expect(isValidTimeZone('-04:00')).toBe(false);
  });

  it('rejects unknown names and junk', () => {
    for (const zone of ['Mars/Olympus_Mons', 'Asia/', '', 'Asia/Kolkata; DROP TABLE', '../../etc/passwd']) {
      expect(isValidTimeZone(zone), zone).toBe(false);
    }
  });
});

describe('timeZoneSchema', () => {
  it('parses a valid zone and reports an unknown one', () => {
    expect(timeZoneSchema.parse('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(timeZoneSchema.safeParse('Nowhere/Land').error?.issues[0]?.message).toBe('Unknown time zone');
  });
});
