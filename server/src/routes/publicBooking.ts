import { Router, type RequestHandler } from 'express';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { slotsQuerySchema, type PublicEventTypeResponse, type SlotsResponse } from '@calendar-aggregator/shared';
import { localDayInterval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import { availableSlots } from '../calendar/availableSlots.ts';
import { CalendarProviderError } from '../calendar/provider.ts';
import type { CalendarProviders } from '../calendar/syncCalendars.ts';
import { HttpError } from '../utils/httpError.ts';

// Guests never learn why (no calendar names, no account details): only that it's temporary.
export const SLOTS_UNAVAILABLE = "This booking page can't show times right now. Please try again in a few minutes.";

// Shaped like valid values so a malformed link is a plain 404, never a 400 that hints at the format.
const pathSchema = z.object({ handle: z.string().max(30), slug: z.string().max(60) });

// The public booking pages' API: no sign-in, rate limited. Under /book/ (like the page,
// /book/:handle/:slug) so a handle can never collide with another public route such as phase 7's
// /bookings/:token.
export function publicBookingRouter({
  db,
  providers,
  now,
  limiter,
}: {
  db: Db;
  providers: CalendarProviders;
  now: () => Date;
  limiter: RequestHandler;
}): Router {
  const router = Router();
  router.use(limiter);

  // Only active event types are public; a missing host, a missing event type and a turned-off one
  // all get the same 404.
  const findEventType = async (params: unknown) => {
    const parsed = pathSchema.safeParse(params);
    const eventType = parsed.success
      ? await db.eventType.findFirst({
          where: { slug: parsed.data.slug, active: true, user: { handle: parsed.data.handle } },
          select: {
            slug: true,
            title: true,
            description: true,
            durationMinutes: true,
            slotStepMinutes: true,
            user: {
              select: {
                id: true,
                name: true,
                timeZone: true,
                bufferBeforeMinutes: true,
                bufferAfterMinutes: true,
                minNoticeMinutes: true,
                horizonDays: true,
                maxPerDay: true,
              },
            },
          },
        })
      : null;
    if (!eventType) throw new HttpError(404, 'This booking page doesn\'t exist');
    return eventType;
  };

  router.get('/book/:handle/:slug', async (req, res) => {
    const { user, slug, title, description, durationMinutes } = await findEventType(req.params);
    res.json({
      host: { name: user.name, timeZone: user.timeZone },
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

  return router;
}
