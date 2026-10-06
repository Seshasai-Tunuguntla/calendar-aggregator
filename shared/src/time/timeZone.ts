import { z } from 'zod';

// IANA zone names only: 'Asia/Kolkata', 'America/Argentina/Buenos_Aires', 'UTC', and legacy names
// such as 'EST5EDT' or 'GMT0'. A name starts with a letter, so fixed offsets such as '+05:30' are
// rejected even though Intl accepts them: they don't follow DST, so a host in New York stored as
// '-04:00' would be an hour off all winter.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_LENGTH = 64;

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length > MAX_LENGTH || !IANA_NAME.test(timeZone)) return false;
  try {
    // Throws a RangeError for a zone this runtime doesn't know.
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().refine(isValidTimeZone, { message: 'Unknown time zone' });
