import { DAY_MS, MINUTE_MS, computeSlots, type Interval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import { cachedBusyIntervals } from './busyCache.ts';
import type { ConnectionRef } from './provider.ts';
import { providerFor, type CalendarProviders } from './syncCalendars.ts';

export interface SlotHost {
  id: string;
  timeZone: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  maxPerDay: number | null;
}

export interface SlotEventType {
  durationMinutes: number;
  slotStepMinutes: number;
}

// A local day is at most 25 hours, so this margin around the slot window covers every local day
// a slot can fall on, for counting bookings per day.
const DAY_COUNT_MARGIN_MS = 2 * DAY_MS;

// The bookable slots of one event type that start in `range`: gathers the inputs (rules, busy
// times from every calendar that counts as busy, confirmed bookings) and runs the pure slot
// algorithm.
//
// Busy times are fetched only for the part of `range` that minimum notice and the horizon leave
// open, widened by the buffers and the event's length (the time a slot at either edge needs
// clear), so a far-future or past range costs no calendar requests at all. They come through a
// 60-second cache (busyCache.ts), so many guests on one page cause one read of the calendars.
//
// Fails closed: if any calendar that counts as busy can't be read (needs reconnecting,
// unreadable, provider down), the provider's CalendarProviderError propagates and no slots are
// offered, because offering them could double-book the host.
export async function availableSlots({
  db,
  providers,
  host,
  eventType,
  range,
  now,
}: {
  db: Db;
  providers: CalendarProviders;
  host: SlotHost;
  eventType: SlotEventType;
  range: Interval;
  now: number;
}): Promise<Interval[]> {
  const earliest = Math.max(range.start, now + host.minNoticeMinutes * MINUTE_MS);
  const latest = Math.min(range.end - 1, now + host.horizonDays * DAY_MS);
  if (latest < earliest) return [];

  const duration = eventType.durationMinutes * MINUTE_MS;
  const busyRange = {
    start: earliest - host.bufferBeforeMinutes * MINUTE_MS,
    end: latest + duration + host.bufferAfterMinutes * MINUTE_MS,
  };

  const [rules, bookings] = await Promise.all([
    db.availabilityRule.findMany({ where: { userId: host.id }, select: { weekday: true, startMinute: true, endMinute: true } }),
    // Always read fresh, never cached: a booking made a second ago must block its time.
    db.booking.findMany({
      where: {
        hostId: host.id,
        status: 'CONFIRMED',
        startsAt: { lt: new Date(busyRange.end + DAY_COUNT_MARGIN_MS) },
        endsAt: { gt: new Date(busyRange.start - DAY_COUNT_MARGIN_MS) },
      },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  if (rules.length === 0) return [];

  const busy = await cachedBusyIntervals({
    db,
    hostId: host.id,
    range: busyRange,
    now,
    load: (window) => readBusyIntervals(db, providers, host.id, window),
  });

  return computeSlots({
    rules,
    hostTimeZone: host.timeZone,
    busy,
    bookings: bookings.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
    bufferBeforeMinutes: host.bufferBeforeMinutes,
    bufferAfterMinutes: host.bufferAfterMinutes,
    minNoticeMinutes: host.minNoticeMinutes,
    horizonDays: host.horizonDays,
    maxPerDay: host.maxPerDay,
    durationMinutes: eventType.durationMinutes,
    slotStepMinutes: eventType.slotStepMinutes,
    now,
    range,
  });
}

// Busy time from every calendar that counts as busy, asking each connection's provider in parallel.
async function readBusyIntervals(db: Db, providers: CalendarProviders, hostId: string, window: Interval): Promise<Interval[]> {
  const calendars = await db.calendar.findMany({
    where: { countsAsBusy: true, connection: { userId: hostId } },
    select: { externalCalendarId: true, connection: { select: { id: true, userId: true, provider: true } } },
  });
  const byConnection = new Map<string, { connection: ConnectionRef; ids: string[] }>();
  for (const { externalCalendarId, connection } of calendars) {
    const entry = byConnection.get(connection.id) ?? { connection, ids: [] };
    entry.ids.push(externalCalendarId);
    byConnection.set(connection.id, entry);
  }
  const results = await Promise.all(
    [...byConnection.values()].map(({ connection, ids }) => providerFor(providers, connection).getBusyIntervals(connection, ids, window)),
  );
  return results.flat();
}
