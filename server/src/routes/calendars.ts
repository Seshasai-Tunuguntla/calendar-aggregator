import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  setBookingCalendarRequestSchema,
  updateCalendarRequestSchema,
  type Calendar,
  type CalendarResponse,
  type CalendarsResponse,
} from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { bookingCalendarFor, retryEventRemovals } from '../bookings/bookings.ts';
import { invalidateBusyCache } from '../calendar/busyCache.ts';
import { CalendarProviderError } from '../calendar/provider.ts';
import { providerFor, syncUserCalendars, type CalendarProviders } from '../calendar/syncCalendars.ts';
import { currentUser } from '../middleware/auth.ts';
import { HttpError } from '../utils/httpError.ts';

const idParamSchema = z.object({ id: z.uuid('Calendar not found') });

export const CANT_CHECK_NOW = "Can't check your calendar right now. Try again in a minute.";
export const UNREADABLE_CALENDAR =
  "This calendar doesn't share its busy times (holiday calendars are like this), so it can't block bookings.";

const calendarFields = {
  id: true,
  connectionId: true,
  name: true,
  isPrimary: true,
  countsAsBusy: true,
  canCreateEvents: true,
  busyAccess: true,
  connection: { select: { accountEmail: true, status: true } },
} as const;

type CalendarRow = { connection: { accountEmail: string; status: Calendar['connectionStatus'] } } & Omit<Calendar, 'accountEmail' | 'connectionStatus'>;

function toCalendar({ connection, ...calendar }: CalendarRow): Calendar {
  return { ...calendar, accountEmail: connection.accountEmail, connectionStatus: connection.status };
}

export function calendarsRouter({ db, requireAuth, providers }: { db: Db; requireAuth: RequestHandler; providers: CalendarProviders }): Router {
  const router = Router();
  router.use(requireAuth);

  const list = async (userId: string): Promise<CalendarsResponse> => {
    const calendars = await db.calendar.findMany({
      where: { connection: { userId } },
      orderBy: [{ connection: { createdAt: 'asc' } }, { isPrimary: 'desc' }, { name: 'asc' }],
      select: calendarFields,
    });
    const bookingCalendar = await bookingCalendarFor(db, userId);
    return { calendars: calendars.map(toCalendar), bookingCalendarId: bookingCalendar?.id ?? null };
  };

  router.get('/', async (req, res) => {
    res.json(await list(currentUser(req).id));
  });

  // "Refresh": copies each account's calendar list again, re-checks which can be read, and retries
  // removing the events of bookings cancelled while access had expired.
  router.post('/sync', async (req, res) => {
    const user = currentUser(req);
    await syncUserCalendars(db, providers, user.id);
    await retryEventRemovals(db, providers, user.id);
    res.json(await list(user.id));
  });

  // Where booking events are created: one of the host's own calendars that events can be created
  // in (a subscribed or shared calendar can't take them).
  router.put('/booking-calendar', async (req, res) => {
    const user = currentUser(req);
    const { calendarId } = setBookingCalendarRequestSchema.parse(req.body);
    const calendar = await db.calendar.findFirst({ where: { id: calendarId, connection: { userId: user.id } }, select: { canCreateEvents: true } });
    if (!calendar) throw new HttpError(404, 'Calendar not found');
    if (!calendar.canCreateEvents) throw new HttpError(409, "Bookings can only go into a calendar you own, not one shared with you or subscribed to");
    await db.user.update({ where: { id: user.id }, data: { bookingCalendarId: calendarId } });
    res.json(await list(user.id));
  });

  // Unticking always works. Ticking checks with the provider first, every time, so the stored
  // access never goes stale: a calendar that can't be read permanently is refused (409); if the
  // check fails for a temporary reason, the host is told to try again (503) and nothing is marked
  // unreadable.
  router.patch('/:id', async (req, res) => {
    const user = currentUser(req);
    const parsed = idParamSchema.safeParse(req.params);
    const calendar = parsed.success
      ? await db.calendar.findFirst({ where: { id: parsed.data.id, connection: { userId: user.id } }, include: { connection: true } })
      : null;
    if (!calendar) throw new HttpError(404, 'Calendar not found');
    const { countsAsBusy } = updateCalendarRequestSchema.parse(req.body);

    // Which calendars count changes the host's busy time, so the cached copy goes.
    const save = async (data: { countsAsBusy?: boolean; busyAccess?: Calendar['busyAccess'] }) => {
      const saved = await db.calendar.update({ where: { id: calendar.id }, data, select: calendarFields });
      if (data.countsAsBusy !== undefined) await invalidateBusyCache(db, user.id);
      return saved;
    };

    if (!countsAsBusy) {
      res.json({ calendar: toCalendar(await save({ countsAsBusy: false })) } satisfies CalendarResponse);
      return;
    }

    let access;
    try {
      const { connection } = calendar;
      access = (await providerFor(providers, connection).checkBusyAccess(connection, [calendar.externalCalendarId])).get(calendar.externalCalendarId);
    } catch (error) {
      if (!(error instanceof CalendarProviderError)) throw error;
      if (error.kind === 'auth') throw new HttpError(409, `Reconnect ${calendar.connection.accountEmail} to use its calendars`);
      await save({ busyAccess: 'UNKNOWN' });
      throw new HttpError(503, CANT_CHECK_NOW);
    }
    if (access === 'UNREADABLE') {
      await save({ busyAccess: 'UNREADABLE' });
      throw new HttpError(409, UNREADABLE_CALENDAR);
    }
    if (access !== 'READABLE') {
      await save({ busyAccess: 'UNKNOWN' });
      throw new HttpError(503, CANT_CHECK_NOW);
    }
    res.json({ calendar: toCalendar(await save({ countsAsBusy: true, busyAccess: 'READABLE' })) } satisfies CalendarResponse);
  });

  return router;
}
