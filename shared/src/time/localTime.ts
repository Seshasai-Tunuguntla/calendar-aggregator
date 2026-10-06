// How an instant reads on a wall clock in a given zone. Built on Intl only (no Temporal), so the
// client can use it to show slots in the guest's time zone without the polyfill.
export interface LocalParts {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm', 24-hour */
  time: string;
  /** ISO weekday: 1 = Monday ... 7 = Sunday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Creating an Intl.DateTimeFormat is slow compared with using one, and a page formats many slots.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function localParts(epochMs: number, timeZone: string): LocalParts {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(epochMs)) parts[part.type] = part.value;

  const weekday = WEEKDAYS[parts.weekday ?? ''];
  if (weekday === undefined) throw new Error(`Unexpected weekday from Intl: ${parts.weekday}`);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday,
  };
}
