import { Temporal } from 'temporal-polyfill';
import { DEMO_HANDLE, type WeeklyRule } from '@calendar-aggregator/shared';
import type { Interval } from '@calendar-aggregator/shared/slots';

// The public demo's host, "Priya", as pure data: stable ids (so links and tests never change),
// and busy events built relative to a given day, so the demo never shows an empty or past week.
// Phase 10 adds the self-resetting machinery that rebuilds this data.

export const DEMO_TIME_ZONE = 'Asia/Kolkata';

export const DEMO_IDS = {
  host: 'd3e0c0de-0000-4000-8000-000000000001',
  connection: 'd3e0c0de-0000-4000-8000-000000000002',
  calendars: {
    work: 'd3e0c0de-0000-4000-8000-000000000011',
    personal: 'd3e0c0de-0000-4000-8000-000000000012',
    holidays: 'd3e0c0de-0000-4000-8000-000000000013',
  },
  eventTypes: {
    chat: 'd3e0c0de-0000-4000-8000-000000000021',
    call: 'd3e0c0de-0000-4000-8000-000000000022',
    session: 'd3e0c0de-0000-4000-8000-000000000023',
  },
} as const;

export const DEMO_HOST = {
  id: DEMO_IDS.host,
  name: 'Priya Sharma',
  email: 'priya.demo@example.com',
  handle: DEMO_HANDLE,
  timeZone: DEMO_TIME_ZONE,
  isDemo: true,
  bufferBeforeMinutes: 5,
  bufferAfterMinutes: 10,
  minNoticeMinutes: 240,
  horizonDays: 30,
  maxPerDay: 6,
};

export const DEMO_CONNECTION = {
  id: DEMO_IDS.connection,
  userId: DEMO_IDS.host,
  provider: 'DEMO' as const,
  externalAccountId: 'demo-priya',
  accountEmail: DEMO_HOST.email,
  grantedScopes: [],
};

export type DemoCalendarKey = keyof typeof DEMO_IDS.calendars;

// Three calendars, like a typical Google account. Work and Personal are Priya's own (events can be
// created there, and unticking Personal visibly changes the free slots). "Holidays in India" is a
// subscribed calendar with Google's real id: Google won't share free/busy for holiday calendars,
// so, as in the real app, it can't count as busy (see the README's known trade-offs).
export const DEMO_CALENDARS: readonly {
  key: DemoCalendarKey;
  externalCalendarId: string;
  name: string;
  isPrimary: boolean;
  countsAsBusy: boolean;
  canCreateEvents: boolean;
  busyAccess: 'READABLE' | 'UNREADABLE';
}[] = [
  { key: 'work', externalCalendarId: 'demo-work', name: 'Work', isPrimary: true, countsAsBusy: true, canCreateEvents: true, busyAccess: 'READABLE' },
  { key: 'personal', externalCalendarId: 'demo-personal', name: 'Personal', isPrimary: false, countsAsBusy: true, canCreateEvents: true, busyAccess: 'READABLE' },
  {
    key: 'holidays',
    externalCalendarId: 'en.indian#holiday@group.v.calendar.google.com',
    name: 'Holidays in India',
    isPrimary: false,
    countsAsBusy: false,
    canCreateEvents: false,
    busyAccess: 'UNREADABLE',
  },
];

const hours = (from: string, to: string) => ({ startMinute: toMinute(from), endMinute: toMinute(to) });

// Weekdays 10:00-13:00 and 14:00-18:00 (a lunch break), and Saturday mornings.
export const DEMO_RULES: readonly WeeklyRule[] = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, ...hours('10:00', '13:00') },
    { weekday, ...hours('14:00', '18:00') },
  ]),
  { weekday: 6, ...hours('10:00', '12:00') },
];

export const DEMO_EVENT_TYPES = [
  { id: DEMO_IDS.eventTypes.chat, slug: '15-min-chat', title: '15-min chat', description: 'A quick intro call.', durationMinutes: 15, slotStepMinutes: 15 },
  { id: DEMO_IDS.eventTypes.call, slug: '30-min-call', title: '30-min call', description: 'Talk through a question or a project.', durationMinutes: 30, slotStepMinutes: 30 },
  { id: DEMO_IDS.eventTypes.session, slug: '60-min-session', title: '60-min session', description: 'A longer working session.', durationMinutes: 60, slotStepMinutes: 30 },
] as const;

export interface DemoBusyEventData extends Interval {
  // No holiday events: that calendar's busy times can't be read (see DEMO_CALENDARS).
  calendar: Exclude<DemoCalendarKey, 'holidays'>;
}

// Optional work meetings; each weekday gets a different mix (see busyEventsFor).
const MEETING_SLOTS = [hours('10:30', '11:30'), hours('11:30', '12:00'), hours('12:00', '13:00'), hours('14:00', '15:00'),
  hours('15:00', '15:30'), hours('15:30', '16:30'), hours('16:30', '17:30')];

// Busy events from the day before `today` through `days` days after it, in Priya's time zone.
// Deterministic: the same date always gets the same events, so a reset never reshuffles a day
// someone is looking at, and tests can rely on it.
export function buildDemoBusyEvents(today: Temporal.PlainDate, days = 21): DemoBusyEventData[] {
  const events: DemoBusyEventData[] = [];
  for (let offset = -1; offset <= days; offset++) {
    events.push(...busyEventsFor(today.add({ days: offset })));
  }
  return events.toSorted((a, b) => a.start - b.start);
}

function busyEventsFor(date: Temporal.PlainDate): DemoBusyEventData[] {
  const at = (calendar: DemoBusyEventData['calendar'], slot: { startMinute: number; endMinute: number }) => ({
    calendar,
    start: localMinute(date, slot.startMinute),
    end: localMinute(date, slot.endMinute),
  });
  const random = seededRandom(date.toString());
  const events: DemoBusyEventData[] = [];

  if (date.dayOfWeek <= 5) {
    events.push(at('work', hours('10:00', '10:15'))); // daily stand-up
    // One to three of the optional meetings, picked per date.
    const count = 1 + Math.floor(random() * 3);
    const picked = new Set<number>();
    while (picked.size < count) picked.add(Math.floor(random() * MEETING_SLOTS.length));
    for (const index of picked) {
      const slot = MEETING_SLOTS[index];
      if (slot) events.push(at('work', slot));
    }
    if (date.dayOfWeek === 3) events.push(at('personal', hours('17:00', '18:00'))); // Wednesday gym
    if (random() < 0.25) events.push(at('personal', hours('11:00', '12:00'))); // an errand
  }
  if (date.dayOfWeek === 6 && random() < 0.5) events.push(at('personal', hours('10:00', '11:00')));

  return events;
}

function localMinute(date: Temporal.PlainDate, minute: number): number {
  const time = new Temporal.PlainTime(Math.floor(minute / 60), minute % 60);
  return date.toPlainDateTime(time).toZonedDateTime(DEMO_TIME_ZONE).epochMilliseconds;
}

function toMinute(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// mulberry32 seeded from the date string, so each date has its own fixed "random" choices.
function seededRandom(seedText: string): () => number {
  let state = [...seedText].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
