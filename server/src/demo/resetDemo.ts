import type { Prisma } from '@prisma/client';
import { localDate } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import {
  DEMO_CALENDARS,
  DEMO_CONNECTION,
  DEMO_EVENT_TYPES,
  DEMO_HOST,
  DEMO_IDS,
  DEMO_RULES,
  DEMO_TIME_ZONE,
  buildDemoBusyEvents,
} from './demoData.ts';

// The public demo rebuilds itself (the Study Scheduler's pattern): everything a visitor can change
// is put back, and the busy events are regenerated around "today", so the demo never shows a
// changed setup or a past week.
//
// - When: on a cold start and on "Try as host", but only if the last rebuild is 30+ minutes old.
//   The time is in the database (DemoState), so every server instance agrees.
// - One at a time: a transaction-scoped advisory lock. A second request that finds a rebuild due
//   waits for the first, then sees it done and doesn't rebuild again.
// - Bookings: the rebuild also holds the demo host's booking lock (the one booking changes take),
//   so it never interleaves with a guest booking, moving or cancelling.
// - Stable ids: the host, the connection, the calendars and the event types keep the same ids, so
//   links stay valid. Visitors' sessions are kept: someone looking at the dashboard stays signed in
//   and simply sees the fresh demo.

export const DEMO_RESET_INTERVAL_MS = 30 * 60 * 1000;
const RESET_LOCK = 'calendar-aggregator:demo-reset';

/** Rebuilds the demo if it was never built or was last rebuilt 30+ minutes ago. True if it rebuilt. */
export function resetDemoIfStale(db: Db, now: Date): Promise<boolean> {
  return rebuildIf(db, now, (lastResetAt) => lastResetAt === null || now.getTime() - lastResetAt.getTime() >= DEMO_RESET_INTERVAL_MS);
}

/**
 * Builds the demo only if it doesn't exist yet: "Try booking" must work on a fresh database before
 * anyone has pressed "Try as host". It never resets a demo that exists.
 */
export function ensureDemoExists(db: Db, now: Date): Promise<boolean> {
  return rebuildIf(db, now, (lastResetAt) => lastResetAt === null);
}

// `due` gets the last reset time, or null when the demo hasn't been built (no DemoState row, or no
// demo host: a test or a person may have emptied the tables).
async function rebuildIf(db: Db, now: Date, due: (lastResetAt: Date | null) => boolean): Promise<boolean> {
  // Most calls find nothing to do: answer them without taking the lock.
  if (!due(await lastReset(db))) return false;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${RESET_LOCK}, 0))`;
      // Checked again under the lock: another request may have just rebuilt it.
      if (!due(await lastReset(tx))) return false;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DEMO_IDS.host}, 0))`;
      await rebuild(tx, now);
      await tx.demoState.upsert({ where: { id: 1 }, create: { id: 1, lastResetAt: now }, update: { lastResetAt: now } });
      return true;
    },
    // A rebuild writes a few hundred rows; leave room for waiting behind another one.
    { maxWait: 10_000, timeout: 30_000 },
  );
}

async function lastReset(db: Db | Prisma.TransactionClient): Promise<Date | null> {
  const [state, host] = await Promise.all([
    db.demoState.findUnique({ where: { id: 1 } }),
    db.user.findUnique({ where: { id: DEMO_IDS.host }, select: { id: true } }),
  ]);
  return state && host ? state.lastResetAt : null;
}

async function rebuild(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  const host = DEMO_IDS.host;
  // The host row is updated in place (not deleted), so visitors' sessions survive the rebuild. (Their
  // choice of booking calendar is cleared below: deleting the calendars sets it to null.)
  await tx.user.upsert({ where: { id: host }, create: DEMO_HOST, update: DEMO_HOST });

  // Bookings first: an event type with bookings can't be deleted. Then everything the visitor may
  // have added, changed or removed, recreated with the same ids.
  await tx.booking.deleteMany({ where: { hostId: host } });
  await tx.eventType.deleteMany({ where: { userId: host } });
  // Deleting the connections removes their calendars and those calendars' demo events too.
  await tx.calendarConnection.deleteMany({ where: { userId: host } });
  await tx.availabilityRule.deleteMany({ where: { userId: host } });
  await tx.busyCache.deleteMany({ where: { hostId: host } });

  await tx.calendarConnection.create({ data: DEMO_CONNECTION });
  await tx.calendar.createMany({
    data: DEMO_CALENDARS.map(({ key, ...calendar }) => ({ ...calendar, id: DEMO_IDS.calendars[key], connectionId: DEMO_IDS.connection })),
  });
  await tx.availabilityRule.createMany({ data: DEMO_RULES.map((rule) => ({ ...rule, userId: host })) });
  await tx.eventType.createMany({ data: DEMO_EVENT_TYPES.map((eventType) => ({ ...eventType, userId: host })) });
  // From the day before today through the end of the booking horizon (and a day more, for guests
  // in zones ahead of Priya's), so every day a guest can book looks like a real week.
  const busy = buildDemoBusyEvents(localDate(now.getTime(), DEMO_TIME_ZONE), DEMO_HOST.horizonDays + 1);
  await tx.demoBusyEvent.createMany({
    data: busy.map((event) => ({ calendarId: DEMO_IDS.calendars[event.calendar], startsAt: new Date(event.start), endsAt: new Date(event.end) })),
  });
}
