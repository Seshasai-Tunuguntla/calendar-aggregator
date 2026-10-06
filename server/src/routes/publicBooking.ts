import { Router, type RequestHandler } from 'express';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import {
  createBookingRequestSchema,
  rescheduleBookingRequestSchema,
  slotsQuerySchema,
  type CreateBookingResponse,
  type GuestBooking,
  type GuestBookingResponse,
  type PublicEventTypeResponse,
  type SlotsResponse,
} from '@calendar-aggregator/shared';
import { localDayInterval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import { bookingHostFields, cancelBooking, createBooking, findByManageToken, rescheduleBooking } from '../bookings/bookings.ts';
import { availableSlots } from '../calendar/availableSlots.ts';
import type { Timeouts } from '../bookings/timeouts.ts';
import { CalendarProviderError } from '../calendar/provider.ts';
import { DEMO_HOST } from '../demo/demoData.ts';
import { ensureDemoHost } from '../demo/ensureDemoHost.ts';
import type { CalendarProviders } from '../calendar/syncCalendars.ts';
import { HttpError } from '../utils/httpError.ts';

// Guests never learn why (no calendar names, no account details): only that it's temporary.
export const SLOTS_UNAVAILABLE = "This booking page can't show times right now. Please try again in a few minutes.";
export const BOOKING_NOT_FOUND = 'This booking link is not valid. Check that you copied all of it.';

// Shaped like valid values so a malformed link is a plain 404, never a 400 that hints at the format.
const pathSchema = z.object({ handle: z.string().max(30), slug: z.string().max(60) });
// Manage tokens are 32 random bytes in base64url.
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

type ManagedBooking = NonNullable<Awaited<ReturnType<typeof findByManageToken>>>;

function guestView(booking: ManagedBooking, now: number): GuestBooking {
  const { eventType } = booking;
  return {
    status: booking.status,
    start: booking.startsAt.toISOString(),
    end: booking.endsAt.toISOString(),
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    guestTimeZone: booking.guestTimeZone,
    host: { name: eventType.user.name, timeZone: eventType.user.timeZone, isDemo: eventType.user.isDemo },
    eventType: {
      title: eventType.title,
      durationMinutes: (booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000,
      bookingPath: `/book/${eventType.user.handle}/${eventType.slug}`,
    },
    canChange: booking.status === 'CONFIRMED' && booking.startsAt.getTime() > now,
  };
}

// The public pages' API: no sign-in. The app rate limits all of /api/public (one shared count per
// client); changes also pass `bookingLimiter`, since each one writes to the host's calendar.
// Booking pages live under /book/ (like the page, /book/:handle/:slug), so a handle can never
// collide with /bookings/:token.
export function publicBookingRouter({
  db,
  providers,
  now,
  bookingLimiter,
  dailyBookingLimiter,
  timeouts,
  beforeBookingLock,
}: {
  db: Db;
  providers: CalendarProviders;
  now: () => Date;
  bookingLimiter: RequestHandler;
  /** Creating bookings only: each one makes Google email an invitation. */
  dailyBookingLimiter: RequestHandler;
  timeouts: Timeouts;
  beforeBookingLock?: (() => Promise<void>) | undefined;
}): Router {
  const router = Router();

  // Only active event types are public; a missing host, a missing event type and a turned-off one
  // all get the same 404.
  const findEventType = async (params: unknown) => {
    const parsed = pathSchema.safeParse(params);
    // "Try booking" must work before anyone has used "Try as host": create the demo host on first
    // visit. (Phase 10 turns this into the periodic, locked reset.)
    if (parsed.success && parsed.data.handle === DEMO_HOST.handle) await ensureDemoHost(db, now());
    const eventType = parsed.success
      ? await db.eventType.findFirst({
          where: { slug: parsed.data.slug, active: true, user: { handle: parsed.data.handle } },
          select: { id: true, slug: true, title: true, description: true, durationMinutes: true, slotStepMinutes: true, user: { select: bookingHostFields } },
        })
      : null;
    if (!eventType) throw new HttpError(404, "This booking page doesn't exist");
    return eventType;
  };

  const findBooking = async (params: unknown) => {
    const parsed = tokenSchema.safeParse(params);
    const booking = parsed.success ? await findByManageToken(db, parsed.data.token) : null;
    if (!booking) throw new HttpError(404, BOOKING_NOT_FOUND);
    return booking;
  };

  router.get('/book/:handle/:slug', async (req, res) => {
    const { user, slug, title, description, durationMinutes } = await findEventType(req.params);
    res.json({
      host: { name: user.name, timeZone: user.timeZone, isDemo: user.isDemo },
      eventType: { slug, title, description, durationMinutes },
    } satisfies PublicEventTypeResponse);
  });

  // ?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<guest's zone>: slots starting on those days of the guest's
  // calendar (to exclusive). The client groups them by the guest's date with localParts().
  router.get('/book/:handle/:slug/slots', async (req, res) => {
    const eventType = await findEventType(req.params);
    const { from, to, tz } = slotsQuerySchema.parse(req.query);
    const range = {
      start: localDayInterval(Temporal.PlainDate.from(from), tz).start,
      end: localDayInterval(Temporal.PlainDate.from(to), tz).start,
    };

    let slots;
    try {
      slots = await availableSlots({ db, providers, host: eventType.user, eventType, range, now: now().getTime() });
    } catch (error) {
      if (!(error instanceof CalendarProviderError)) throw error;
      // The host finds out which calendar on their calendars page (refresh marks it); the log
      // gets the kind, never tokens.
      console.error(`Slots unavailable for host ${eventType.user.id}: ${error.kind}`);
      throw new HttpError(503, SLOTS_UNAVAILABLE);
    }

    res.json({
      slots: slots.map((slot) => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() })),
    } satisfies SlotsResponse);
  });

  // Books a slot. 201 with the guest's view and their manage token, shown this once.
  router.post('/book/:handle/:slug/bookings', bookingLimiter, dailyBookingLimiter, async (req, res) => {
    const eventType = await findEventType(req.params);
    const { start, guestName, guestEmail, guestTimeZone } = createBookingRequestSchema.parse(req.body);
    const { booking, manageToken } = await createBooking({
      db,
      providers,
      host: eventType.user,
      eventType,
      guest: { name: guestName, email: guestEmail, timeZone: guestTimeZone },
      start: Date.parse(start),
      now: now().getTime(),
      timeouts,
      ...(beforeBookingLock ? { beforeLock: beforeBookingLock } : {}),
    });
    const managed = await findByManageToken(db, manageToken);
    if (!managed) throw new Error(`Booking ${booking.id} vanished right after it was made`);
    res.status(201).json({
      booking: guestView(managed, now().getTime()),
      manageToken,
      managePath: `/booking/${manageToken}`,
    } satisfies CreateBookingResponse);
  });

  router.get('/bookings/:token', async (req, res) => {
    res.json({ booking: guestView(await findBooking(req.params), now().getTime()) } satisfies GuestBookingResponse);
  });

  router.post('/bookings/:token/cancel', bookingLimiter, async (req, res) => {
    const booking = await findBooking(req.params);
    const host = booking.eventType.user;
    await cancelBooking({ db, providers, bookingId: booking.id, host, now: now().getTime(), timeouts });
    res.json({ booking: guestView(await findBooking(req.params), now().getTime()) } satisfies GuestBookingResponse);
  });

  router.post('/bookings/:token/reschedule', bookingLimiter, async (req, res) => {
    const booking = await findBooking(req.params);
    const { start } = rescheduleBookingRequestSchema.parse(req.body);
    await rescheduleBooking({
      db,
      providers,
      bookingId: booking.id,
      host: booking.eventType.user,
      slotStepMinutes: booking.eventType.slotStepMinutes,
      start: Date.parse(start),
      now: now().getTime(),
      timeouts,
    });
    res.json({ booking: guestView(await findBooking(req.params), now().getTime()) } satisfies GuestBookingResponse);
  });

  return router;
}
