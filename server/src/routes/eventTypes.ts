import { Router, type RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  createEventTypeRequestSchema,
  updateEventTypeRequestSchema,
  type EventType,
  type EventTypeResponse,
  type EventTypesResponse,
} from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { currentUser } from '../middleware/auth.ts';
import { HttpError } from '../utils/httpError.ts';

const HAS_BOOKINGS = "This event type has bookings, so it can't be deleted. Turn it off instead.";

// The bookings' foreign key (ON DELETE RESTRICT) refusing the delete. Prisma 6 reports Postgres's
// 23001 only as text, as it does the overlap constraint's 23P01 (bookings.ts: isOverlappingBooking).
export function isEventTypeInUse(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23001') &&
    error.message.includes('Booking_eventTypeId_hostId_fkey')
  );
}

const idParamSchema = z.object({ id: z.uuid('Event type not found') });

// Plenty for a person, and it stops a script filling the database (the demo host is shared).
export const MAX_EVENT_TYPES = 50;

const eventTypeFields = {
  id: true,
  slug: true,
  title: true,
  description: true,
  durationMinutes: true,
  slotStepMinutes: true,
  active: true,
} as const;

type EventTypeRow = Omit<EventType, 'bookingPath'>;

const withPath = (handle: string) => (eventType: EventTypeRow): EventType => ({ ...eventType, bookingPath: `/book/${handle}/${eventType.slug}` });

// The slug is unique per host; a clash gets a message that says what to change.
function slugTaken(error: unknown, slug: string | undefined): HttpError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new HttpError(409, `Another of your event types already uses the link "${slug ?? ''}"`);
  }
  return null;
}

export function eventTypesRouter({ db, requireAuth }: { db: Db; requireAuth: RequestHandler }): Router {
  const router = Router();
  router.use(requireAuth);

  // Another host's event type gets the same 404 as a missing one, so ids reveal nothing.
  const findOwn = async (userId: string, params: unknown) => {
    const parsed = idParamSchema.safeParse(params);
    const eventType = parsed.success ? await db.eventType.findFirst({ where: { id: parsed.data.id, userId }, select: { id: true } }) : null;
    if (!eventType) throw new HttpError(404, 'Event type not found');
    return eventType;
  };

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const eventTypes = await db.eventType.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' }, select: eventTypeFields });
    res.json({ eventTypes: eventTypes.map(withPath(user.handle)) } satisfies EventTypesResponse);
  });

  router.post('/', async (req, res) => {
    const user = currentUser(req);
    const data = createEventTypeRequestSchema.parse(req.body);
    if ((await db.eventType.count({ where: { userId: user.id } })) >= MAX_EVENT_TYPES) {
      throw new HttpError(409, `You can have at most ${MAX_EVENT_TYPES} event types`);
    }
    try {
      const eventType = await db.eventType.create({ data: { ...data, userId: user.id }, select: eventTypeFields });
      res.status(201).json({ eventType: withPath(user.handle)(eventType) } satisfies EventTypeResponse);
    } catch (error) {
      throw slugTaken(error, data.slug) ?? error;
    }
  });

  router.patch('/:id', async (req, res) => {
    const user = currentUser(req);
    const { id } = await findOwn(user.id, req.params);
    const data = updateEventTypeRequestSchema.parse(req.body);
    try {
      const eventType = await db.eventType.update({ where: { id }, data, select: eventTypeFields });
      res.json({ eventType: withPath(user.handle)(eventType) } satisfies EventTypeResponse);
    } catch (error) {
      throw slugTaken(error, data.slug) ?? error;
    }
  });

  // An event type with bookings can't be deleted (they'd be lost); the host turns it off instead.
  // Checked first, because Prisma 6 reports the database's own RESTRICT violation (Postgres 23001)
  // only as an unparsed error. That foreign key still guards the rare race with a new booking: the
  // delete then fails (500) and nothing is lost.
  router.delete('/:id', async (req, res) => {
    const { id } = await findOwn(currentUser(req).id, req.params);
    if ((await db.booking.count({ where: { eventTypeId: id } })) > 0) throw new HttpError(409, HAS_BOOKINGS);
    try {
      await db.eventType.delete({ where: { id } });
    } catch (error) {
      // A guest booked it between the count and the delete: the foreign key refuses, with the same answer.
      if (isEventTypeInUse(error)) throw new HttpError(409, HAS_BOOKINGS);
      throw error;
    }
    res.status(204).end();
  });

  return router;
}
