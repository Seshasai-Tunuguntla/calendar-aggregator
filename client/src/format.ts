import { formatMinute } from '@calendar-aggregator/shared';

// Dates and times as the host reads them, in their own time zone (Intl only: no Temporal on the
// client). Formatters are cached: creating one is slow, and pages format many times.
const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
    cache.set(key, f);
  }
  return f;
}

/** "Tue 13 Oct" */
export const formatDay = (iso: string, timeZone: string) => formatter(timeZone, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

/** "14:00" */
export const formatTime = (iso: string, timeZone: string) => formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** "Tuesday 13 October" */
export const formatLongDay = (iso: string, timeZone: string) => formatter(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));

/** "Asia/Kolkata" -> "Kolkata (Asia)", for a time zone list that's readable. */
export function timeZoneLabel(zone: string): string {
  const parts = zone.split('/');
  if (parts.length < 2) return zone;
  const city = (parts.at(-1) ?? zone).replaceAll('_', ' ');
  return `${city} (${parts.slice(0, -1).join(' / ').replaceAll('_', ' ')})`;
}

/** 90 -> "1 h 30 min", 2880 -> "2 days" */
export function formatDuration(minutes: number): string {
  if (minutes === 0) return 'None';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

export { formatMinute };

/** The host's booking link as guests open it. */
export const bookingUrl = (path: string) => `${window.location.origin}${path}`;

/** Morning, afternoon or evening in the host's zone. */
export function greeting(timeZone: string, now = new Date()): string {
  const hour = Number(formatter(timeZone, { hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}
