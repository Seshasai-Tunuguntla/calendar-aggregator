import { localParts, type Slot } from '@calendar-aggregator/shared';

// Times as the guest reads them: in their chosen time zone and in their browser's own language
// (so "9:30 AM" in the US, "09:30" in most of Europe). Intl only: no Temporal on the client.

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone, ...options });
    cache.set(key, f);
  }
  return f;
}

// On a 24-hour clock, "04:30" rather than "4:30", which reads like the afternoon at a glance.
let hourStyle: 'numeric' | '2-digit' | undefined;
const hour = () => (hourStyle ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === false ? '2-digit' : 'numeric');

export const guestTime = (iso: string, timeZone: string) => formatter(timeZone, { hour: hour(), minute: '2-digit' }).format(new Date(iso));
export const guestLongDate = (iso: string, timeZone: string) => formatter(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const guestLongDateWithYear = (iso: string, timeZone: string) =>
  formatter(timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
export const guestMonth = (iso: string, timeZone: string) => formatter(timeZone, { month: 'long', year: 'numeric' }).format(new Date(iso));

// Browsers still report some zones by their old names (Chrome says Asia/Calcutta for India).
// They're valid and the API accepts them; only the label uses today's city name.
const RENAMED_CITIES: Record<string, string> = {
  Calcutta: 'Kolkata',
  Saigon: 'Ho Chi Minh City',
  Katmandu: 'Kathmandu',
  Rangoon: 'Yangon',
  Kiev: 'Kyiv',
  Godthab: 'Nuuk',
};

const placeName = (part: string) => {
  const name = part.replaceAll('_', ' ');
  return RENAMED_CITIES[name] ?? name;
};

/** "Asia/Kolkata" for Asia/Calcutta, "America/New York" for America/New_York: for lists of zones. */
export const zoneName = (zone: string) => zone.split('/').map(placeName).join('/');

/** "Dubai (GMT+4)": the city, and the offset that applies today. */
export function zoneLabel(zone: string, at = new Date()): string {
  const city = placeName(zone.split('/').at(-1) ?? zone);
  const offset = formatter(zone, { timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  return offset ? `${city} (${offset})` : city;
}

/** The browser's own IANA zone. */
export const detectTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Today's date in a zone, as YYYY-MM-DD. */
export const todayIn = (timeZone: string, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);

/** A YYYY-MM-DD date plus whole days (calendar arithmetic on the date itself, no time zone). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface Day {
  /** YYYY-MM-DD in the guest's zone */
  date: string;
  slots: Slot[];
}

// Slots grouped by the guest's own date, in order; only days that have slots appear.
export function groupByDay(slots: readonly Slot[], timeZone: string): Day[] {
  const days = new Map<string, Slot[]>();
  for (const slot of slots) {
    const { date } = localParts(Date.parse(slot.start), timeZone);
    days.set(date, [...(days.get(date) ?? []), slot]);
  }
  return [...days].map(([date, daySlots]) => ({ date, slots: daySlots })).toSorted((a, b) => a.date.localeCompare(b.date));
}
