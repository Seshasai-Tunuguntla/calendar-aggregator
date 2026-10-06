import { Prisma } from '@prisma/client';
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

// Creates the demo host with all their data if they don't exist yet, in one transaction.
// Phase 10 replaces "create if missing" with a full, locked, periodic reset.
export async function ensureDemoHost(db: Db, now: Date): Promise<void> {
  if (await db.user.findUnique({ where: { id: DEMO_IDS.host }, select: { id: true } })) return;

  const busy = buildDemoBusyEvents(localDate(now.getTime(), DEMO_TIME_ZONE));
  try {
    await db.$transaction([
      db.user.create({ data: DEMO_HOST }),
      db.calendarConnection.create({ data: DEMO_CONNECTION }),
      db.calendar.createMany({
        data: DEMO_CALENDARS.map(({ key, ...calendar }) => ({
          ...calendar,
          id: DEMO_IDS.calendars[key],
          connectionId: DEMO_IDS.connection,
        })),
      }),
      db.availabilityRule.createMany({ data: DEMO_RULES.map((rule) => ({ ...rule, userId: DEMO_IDS.host })) }),
      db.eventType.createMany({ data: DEMO_EVENT_TYPES.map((eventType) => ({ ...eventType, userId: DEMO_IDS.host })) }),
      db.demoBusyEvent.createMany({
        data: busy.map((event) => ({
          calendarId: DEMO_IDS.calendars[event.calendar],
          startsAt: new Date(event.start),
          endsAt: new Date(event.end),
        })),
      }),
    ]);
  } catch (error) {
    // Two first-ever demo logins at once: the other request created the host. That's fine.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}
