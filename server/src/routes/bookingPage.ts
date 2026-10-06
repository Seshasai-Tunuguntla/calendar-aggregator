import { Router, type RequestHandler } from 'express';
import type { BookingPageStatus } from '@calendar-aggregator/shared';
import { DAY_MS, MINUTE_MS } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import { readBusyIntervals } from '../calendar/availableSlots.ts';
import { cachedBusyIntervals } from '../calendar/busyCache.ts';
import { CalendarProviderError } from '../calendar/provider.ts';
import type { CalendarProviders } from '../calendar/syncCalendars.ts';
import { currentUser } from '../middleware/auth.ts';

// How far ahead the status check looks: the week a guest most likely opens.
const CHECK_DAYS = 7;

// The host's booking page as guests see it, for the dashboard. The calendar check is the same busy
// lookup guests trigger, through the same 60-second cache, so a dashboard visit costs at most one
// read of the calendars. When it fails, it says which calendar or account, and what to do.
export function bookingPageRouter({
  db,
  requireAuth,
  providers,
  now,
}: {
  db: Db;
  requireAuth: RequestHandler;
  providers: CalendarProviders;
  now: () => Date;
}): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/status', async (req, res) => {
    const { id: hostId } = currentUser(req);
    const [host, activeEventTypes, rules] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: hostId }, select: { minNoticeMinutes: true, horizonDays: true } }),
      db.eventType.count({ where: { userId: hostId, active: true } }),
      db.availabilityRule.count({ where: { userId: hostId } }),
    ]);

    const start = now().getTime() + host.minNoticeMinutes * MINUTE_MS;
    const end = Math.min(start + CHECK_DAYS * DAY_MS, now().getTime() + host.horizonDays * DAY_MS);
    let calendarProblem: BookingPageStatus['calendarProblem'] = null;
    if (end > start) {
      try {
        await cachedBusyIntervals({ db, hostId, range: { start, end }, now: now().getTime(), load: (window) => readBusyIntervals(db, providers, hostId, window) });
      } catch (error) {
        if (!(error instanceof CalendarProviderError)) throw error;
        calendarProblem = await describeProblem(db, hostId, error);
      }
    }

    res.json({ activeEventTypes, hasHours: rules > 0, calendarProblem } satisfies BookingPageStatus);
  });

  return router;
}

async function describeProblem(db: Db, hostId: string, error: CalendarProviderError): Promise<NonNullable<BookingPageStatus['calendarProblem']>> {
  if (error.kind === 'auth') {
    // The token service has marked the account; name the first one that has busy calendars.
    const connection = await db.calendarConnection.findFirst({
      where: { userId: hostId, status: 'NEEDS_RECONNECT', calendars: { some: { countsAsBusy: true } } },
      orderBy: { createdAt: 'asc' },
      select: { accountEmail: true },
    });
    return { kind: 'reconnect', calendarName: null, accountEmail: connection?.accountEmail ?? null };
  }
  const calendar = error.externalCalendarId
    ? await db.calendar.findFirst({
        where: { externalCalendarId: error.externalCalendarId, countsAsBusy: true, connection: { userId: hostId } },
        select: { name: true, connection: { select: { accountEmail: true } } },
      })
    : null;
  return {
    kind: error.kind === 'not_found' ? 'unreadable' : 'temporary',
    calendarName: calendar?.name ?? null,
    accountEmail: calendar?.connection.accountEmail ?? null,
  };
}
