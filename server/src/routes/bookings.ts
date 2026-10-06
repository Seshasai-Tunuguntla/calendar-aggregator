import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { HostBooking, HostBookingResponse, HostBookingsResponse } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { cancelBooking } from '../bookings/bookings.ts';
import type { Timeouts } from '../bookings/timeouts.ts';
import type { CalendarProviders } from '../calendar/syncCalendars.ts';
import { currentUser } from '../middleware/auth.ts';
import { HttpError } from '../utils/httpError.ts';

export const PAGE_SIZE = 20;

const idParamSchema = z.object({ id: z.uuid('Booking not found') });
const listQuerySchema = z.object({ cursor: z.uuid('Invalid cursor').optional() });

const bookingFields = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  guestName: true,
  guestEmail: true,
  guestTimeZone: true,
  stillOnCalendar: true,
  eventType: { select: { id: true, title: true } },
} as const;

type BookingRow = {
  id: string;
  status: HostBooking['status'];
  startsAt: Date;
  endsAt: Date;
  guestName: string;
  guestEmail: string;
  guestTimeZone: string;
  stillOnCalendar: boolean;
  eventType: { id: string; title: string };
};

const hostView = ({ startsAt, endsAt, ...booking }: BookingRow): HostBooking => ({ ...booking, start: startsAt.toISOString(), end: endsAt.toISOString() });

// The signed-in host's bookings: guest names and emails are visible here and nowhere else.
export function bookingsRouter({
  db,
  requireAuth,
  providers,
  now,
  timeouts,
}: {
  db: Db;
  requireAuth: RequestHandler;
  providers: CalendarProviders;
  now: () => Date;
  timeouts: Timeouts;
}): Router {
  const router = Router();
  router.use(requireAuth);

  // Upcoming confirmed bookings (including one in progress), soonest first, PAGE_SIZE at a time,
  // plus upcoming cancelled ones whose event is still on the host's calendar (the dashboard
  // warns about those).
  // The cursor is the last booking of the previous page (keyset paging on start time, then id, so
  // a booking made meanwhile can't shift the pages).
  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const { cursor } = listQuerySchema.parse(req.query);
    const after = cursor ? await db.booking.findFirst({ where: { id: cursor, hostId: user.id }, select: { id: true, startsAt: true } }) : null;
    if (cursor && !after) throw new HttpError(400, 'Invalid cursor');

    const rows = await db.booking.findMany({
      where: {
        hostId: user.id,
        endsAt: { gt: now() },
        AND: [
          { OR: [{ status: 'CONFIRMED' }, { status: 'CANCELLED', stillOnCalendar: true }] },
          ...(after ? [{ OR: [{ startsAt: { gt: after.startsAt } }, { startsAt: after.startsAt, id: { gt: after.id } }] }] : []),
        ],
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE + 1,
      select: bookingFields,
    });
    const page = rows.slice(0, PAGE_SIZE);
    res.json({ bookings: page.map(hostView), nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null } satisfies HostBookingsResponse);
  });

  // The host cancels; Google tells the guest.
  router.post('/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const parsed = idParamSchema.safeParse(req.params);
    const booking = parsed.success ? await db.booking.findFirst({ where: { id: parsed.data.id, hostId: user.id }, select: { id: true } }) : null;
    if (!booking) throw new HttpError(404, 'Booking not found');
    await cancelBooking({ db, providers, bookingId: booking.id, host: user, now: now().getTime(), timeouts });
    const cancelled = await db.booking.findUniqueOrThrow({ where: { id: booking.id }, select: bookingFields });
    res.json({ booking: hostView(cancelled) } satisfies HostBookingResponse);
  });

  return router;
}
