import { Prisma } from '@prisma/client';
import { MINUTE_MS, type Interval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import { hashToken, newSessionToken } from '../auth/sessions.ts';
import { busyRangeFor, readBusyIntervals, slotsWithBusy, type SlotEventType, type SlotHost } from '../calendar/availableSlots.ts';
import { invalidateBusyCache } from '../calendar/busyCache.ts';
import { CalendarProviderError, type CalendarProvider, type ConnectionRef } from '../calendar/provider.ts';
import { providerFor, type CalendarProviders } from '../calendar/syncCalendars.ts';
import { HttpError } from '../utils/httpError.ts';
import { TIMEOUTS, type Timeouts } from './timeouts.ts';

// How a booking is made without double booking the host (docs/PLAN.md, "Phase 7 decisions"):
//
// 1. Check the slot against FRESH busy times from the host's calendars (not the 60-second cache)
//    and the bookings in our database. Outside any lock: it's the slow part (Google).
// 2. Take the host's lock (a Postgres advisory lock, held until the transaction ends, so it works
//    across server instances) and check again with the bookings as they are now. Two guests who
//    both passed step 1 for the same slot, or for the last slot of a day with a daily limit, are
//    now in line: the second sees the first's booking and gets 409 "That time was just taken".
// 3. Still inside the transaction, insert the booking and create the event on the host's calendar
//    (Google emails the guest). If Google fails, the transaction rolls back: nothing was booked,
//    and the guest is told so. The event's id comes from the booking's id, so a create that timed
//    out after reaching Google can be found and deleted.
// 4. The database's exclusion constraint (no two overlapping confirmed bookings per host) is the
//    last line of defence if anything ever bypasses the lock.
//
// Rescheduling and cancelling take the same lock and change Google inside the transaction too, so
// our records and the host's calendar stay in step.

export const SLOT_UNAVAILABLE = "That time isn't available. Please pick another.";
export const SLOT_TAKEN = 'That time was just taken. Please pick another.';
export const ALREADY_STARTED = "This meeting has already started, so it can't be changed.";
export const BOOKING_CANCELLED = 'This booking was cancelled.';
export const CANT_MOVE = "This booking can't be moved right now. You can cancel it and book a new time instead.";

const cantCheck = (hostName: string) =>
  `We can't check ${hostName}'s calendar right now, so this time can't be booked. Please try again in a few minutes.`;
const cantAdd = (hostName: string) =>
  `We couldn't add this to ${hostName}'s calendar, so nothing was booked. Please try again in a few minutes.`;
const cantReach = (hostName: string) => `We couldn't reach ${hostName}'s calendar, so nothing was changed. Please try again in a few minutes.`;
const cantConfirmCancel = (hostName: string) =>
  `We couldn't confirm the cancellation with ${hostName}'s calendar, so the booking is still on. Please try again in a few minutes.`;
const busyHost = (hostName: string) => `Someone else is booking with ${hostName} right now. Please try again in a moment.`;

export interface BookingHost extends SlotHost {
  name: string;
}

export interface BookingEventType {
  id: string;
  title: string;
  description: string;
  durationMinutes: number;
  slotStepMinutes: number;
}

const isTemporary = (error: CalendarProviderError) => error.kind === 'unavailable' || error.kind === 'rate_limited';

// One booking change per host at a time, across every server instance. The Google call inside
// takes at most timeouts.googleCallMs, so the transaction's own limit (timeouts.transactionMs)
// never cuts it off; waiting for the lock is capped by Postgres (lock_timeout). Bookings for other
// hosts never wait for it.
async function withHostLock<T>(db: Db, host: { id: string; name: string }, timeouts: Timeouts, task: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => {
        // SET can't take a bind parameter; this is our own integer.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.trunc(timeouts.lockWaitMs)}`);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${host.id}, 0))`;
        return task(tx);
      },
      { maxWait: timeouts.connectionWaitMs, timeout: timeouts.transactionMs },
    );
  } catch (error) {
    if (isLockTimeout(error) || isTransactionTimeout(error)) throw new HttpError(503, busyHost(host.name));
    throw error;
  }
}

// Postgres gave up waiting for the host's lock (55P03, lock_not_available).
function isLockTimeout(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.meta?.['code'] === '55P03' || error.message.includes('55P03'));
}

// Prisma's own limits: no pooled connection in time (P2024), or the transaction ran out of time (P2028).
function isTransactionTimeout(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2028' || error.code === 'P2024');
}

// The database refused an overlapping confirmed booking (Postgres 23P01 on the hand-written
// exclusion constraint). Prisma 6 has no error code for it, so it's recognised by its text.
export function isOverlappingBooking(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23P01') &&
    error.message.includes('Booking_no_overlapping_confirmed')
  );
}

const calendarSelect = {
  id: true,
  externalCalendarId: true,
  connection: { select: { id: true, userId: true, provider: true } },
} as const;

// Where a host's booking events go: their chosen calendar if it still exists and they can create
// events in it, otherwise the primary calendar of their first account (then any they own).
export async function bookingCalendarFor(db: Prisma.TransactionClient, userId: string) {
  const { bookingCalendarId } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { bookingCalendarId: true } });
  if (bookingCalendarId) {
    const chosen = await db.calendar.findFirst({ where: { id: bookingCalendarId, canCreateEvents: true, connection: { userId } }, select: calendarSelect });
    if (chosen) return chosen;
  }
  return db.calendar.findFirst({
    where: { canCreateEvents: true, connection: { userId } },
    orderBy: [{ connection: { createdAt: 'asc' } }, { isPrimary: 'desc' }, { name: 'asc' }],
    select: calendarSelect,
  });
}

// Step 1: fresh busy times for one start, and whether that start is bookable with them.
async function freshCheck({
  db,
  providers,
  host,
  eventType,
  start,
  now,
  excludeBookingId,
}: {
  db: Db;
  providers: CalendarProviders;
  host: BookingHost;
  eventType: SlotEventType;
  start: number;
  now: number;
  excludeBookingId?: string;
}): Promise<{ busy: Interval[]; recheck: (tx: Prisma.TransactionClient) => Promise<boolean> }> {
  const query = { host, eventType, range: { start, end: start + 1 }, now };
  const busyRange = busyRangeFor(query);
  if (!busyRange) throw new HttpError(409, SLOT_UNAVAILABLE);
  let busy: Interval[];
  try {
    busy = await readBusyIntervals(db, providers, host.id, busyRange);
  } catch (error) {
    if (error instanceof CalendarProviderError) throw new HttpError(503, cantCheck(host.name));
    throw error;
  }
  const isFree = async (client: Prisma.TransactionClient) =>
    (await slotsWithBusy({ db: client, busy, ...query, ...(excludeBookingId ? { excludeBookingId } : {}) })).some((slot) => slot.start === start);
  if (!(await isFree(db))) {
    // Another guest got this exact time since the page loaded: say so, as the lock's recheck would.
    const end = start + eventType.durationMinutes * MINUTE_MS;
    const taken = await db.booking.count({
      where: { hostId: host.id, status: 'CONFIRMED', startsAt: { lt: new Date(end) }, endsAt: { gt: new Date(start) }, ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}) },
    });
    throw new HttpError(409, taken > 0 ? SLOT_TAKEN : SLOT_UNAVAILABLE);
  }
  return { busy, recheck: isFree };
}

async function bestEffort(what: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`${what} failed:`, error instanceof Error ? error.message : error);
  }
}

export async function createBooking({
  db,
  providers,
  host,
  eventType,
  guest,
  start,
  now,
  timeouts = TIMEOUTS,
  beforeLock,
}: {
  db: Db;
  providers: CalendarProviders;
  host: BookingHost;
  eventType: BookingEventType;
  guest: { name: string; email: string; timeZone: string };
  start: number;
  now: number;
  timeouts?: Timeouts;
  /** Tests only: runs between the first check and taking the lock, to line up concurrent requests. */
  beforeLock?: () => Promise<void>;
}) {
  const end = start + eventType.durationMinutes * MINUTE_MS;
  const { recheck } = await freshCheck({ db, providers, host, eventType, start, now });
  await beforeLock?.();

  const calendar = await bookingCalendarFor(db, host.id);
  if (!calendar) throw new HttpError(503, cantAdd(host.name));
  const manageToken = newSessionToken();

  // Set once Google may hold an event for this booking, so it can be removed if we don't commit.
  const pending: { event: { provider: CalendarProvider; eventId: string } | null } = { event: null };
  try {
    const booking = await withHostLock(db, host, timeouts, async (tx) => {
      if (!(await recheck(tx))) throw new HttpError(409, SLOT_TAKEN);
      const row = await tx.booking.create({
        data: {
          eventTypeId: eventType.id,
          hostId: host.id,
          guestName: guest.name,
          guestEmail: guest.email,
          guestTimeZone: guest.timeZone,
          startsAt: new Date(start),
          endsAt: new Date(end),
          manageTokenHash: hashToken(manageToken),
          calendarId: calendar.id,
        },
      });
      const provider = providerFor(providers, calendar.connection);
      pending.event = { provider, eventId: provider.eventIdFor(row.id) };
      const { externalEventId } = await provider.createEvent(calendar.connection, {
        idempotencyKey: row.id,
        externalCalendarId: calendar.externalCalendarId,
        start: new Date(start),
        end: new Date(end),
        summary: `${eventType.title} with ${guest.name}`,
        description: [eventType.description, 'Booked with Calendar Aggregator.'].filter(Boolean).join('\n\n'),
        attendees: [{ email: guest.email, name: guest.name }],
      });
      pending.event = { provider, eventId: externalEventId };
      return tx.booking.update({ where: { id: row.id }, data: { externalEventId } });
    });
    pending.event = null;
    await invalidateBusyCache(db, host.id);
    return { booking, manageToken };
  } catch (error) {
    const orphan = pending.event;
    if (orphan) {
      // Deleting with sendUpdates=all also withdraws an invitation that went out.
      await bestEffort('Removing the event of a booking that was not saved', () =>
        orphan.provider.deleteEvent(calendar.connection, calendar.externalCalendarId, orphan.eventId),
      );
    }
    if (isOverlappingBooking(error)) throw new HttpError(409, SLOT_TAKEN);
    if (error instanceof CalendarProviderError) throw new HttpError(503, cantAdd(host.name));
    throw error;
  }
}

const bookingWithCalendar = {
  include: { calendar: { select: calendarSelect } },
} as const;

type BookingCalendar = { externalCalendarId: string; connection: ConnectionRef } | null;

export async function rescheduleBooking({
  db,
  providers,
  bookingId,
  host,
  slotStepMinutes,
  start,
  now,
  timeouts = TIMEOUTS,
}: {
  db: Db;
  providers: CalendarProviders;
  bookingId: string;
  host: BookingHost;
  slotStepMinutes: number;
  start: number;
  now: number;
  timeouts?: Timeouts;
}): Promise<void> {
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assertChangeable(booking, now);
  if (booking.startsAt.getTime() === start) return;
  // The booking keeps its own length, even if the event type's has changed since.
  const length = booking.endsAt.getTime() - booking.startsAt.getTime();
  const eventType = { durationMinutes: length / MINUTE_MS, slotStepMinutes };
  const { recheck } = await freshCheck({ db, providers, host, eventType, start, now, excludeBookingId: booking.id });

  // Set once Google has the new time, so it can be moved back if we don't commit.
  const pending: { moved: { calendar: NonNullable<BookingCalendar>; eventId: string; from: Date; to: Date } | null } = { moved: null };
  try {
    await withHostLock(db, host, timeouts, async (tx) => {
      const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, ...bookingWithCalendar });
      assertChangeable(current, now);
      if (!(await recheck(tx))) throw new HttpError(409, SLOT_TAKEN);
      if (current.externalEventId && current.calendar) {
        // Recorded before the call: if it times out, Google may still have moved the event.
        pending.moved = { calendar: current.calendar, eventId: current.externalEventId, from: current.startsAt, to: current.endsAt };
        await providerFor(providers, current.calendar.connection).moveEvent(
          current.calendar.connection,
          current.calendar.externalCalendarId,
          current.externalEventId,
          new Date(start),
          new Date(start + length),
        );
      }
      await tx.booking.update({ where: { id: bookingId }, data: { startsAt: new Date(start), endsAt: new Date(start + length) } });
    });
    pending.moved = null;
  } catch (error) {
    const undo = pending.moved;
    if (undo) {
      await bestEffort('Moving an event back after a failed reschedule', () =>
        providerFor(providers, undo.calendar.connection).moveEvent(undo.calendar.connection, undo.calendar.externalCalendarId, undo.eventId, undo.from, undo.to),
      );
    }
    if (isOverlappingBooking(error)) throw new HttpError(409, SLOT_TAKEN);
    if (error instanceof CalendarProviderError) {
      // Temporary: try again. Otherwise (the host's access expired, or they deleted the event)
      // the event can't be moved, and moving only our record would leave the host's calendar wrong.
      throw isTemporary(error) ? new HttpError(503, cantReach(host.name)) : new HttpError(409, CANT_MOVE);
    }
    throw error;
  }
  await invalidateBusyCache(db, host.id);
}

// Cancels a booking (by the guest or the host). Idempotent: cancelling a cancelled booking is fine.
// The event is deleted first, inside the lock, with sendUpdates=all so Google tells the guest. If
// Google is down for now, nothing changes (try again). If the host's access has expired, the
// booking is cancelled anyway (a guest must always be able to cancel) and marked stillOnCalendar:
// the host's dashboard shows "cancelled, still on your calendar", and retryEventRemovals removes
// the event once the host reconnects.
export async function cancelBooking({
  db,
  providers,
  bookingId,
  host,
  now,
  timeouts = TIMEOUTS,
}: {
  db: Db;
  providers: CalendarProviders;
  bookingId: string;
  host: { id: string; name: string };
  now: number;
  timeouts?: Timeouts;
}): Promise<void> {
  await withHostLock(db, host, timeouts, async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, ...bookingWithCalendar });
    if (booking.status === 'CANCELLED') return;
    if (booking.startsAt.getTime() <= now) throw new HttpError(409, ALREADY_STARTED);
    let stillOnCalendar = false;
    if (booking.externalEventId && booking.calendar) {
      try {
        await providerFor(providers, booking.calendar.connection).deleteEvent(booking.calendar.connection, booking.calendar.externalCalendarId, booking.externalEventId);
      } catch (error) {
        if (!(error instanceof CalendarProviderError)) throw error;
        // Temporary (including a timeout, after which Google may or may not have deleted it): the
        // booking stays on and the guest tries again; deleting again is harmless (404/410 count
        // as deleted).
        if (isTemporary(error)) throw new HttpError(503, cantConfirmCancel(host.name));
        stillOnCalendar = true;
      }
    }
    await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledAt: new Date(now), stillOnCalendar } });
  });
  await invalidateBusyCache(db, host.id);
}

// Tries again to remove the events of bookings that were cancelled while the host's Google access
// had expired ("cancelled, still on your calendar"). Called when the host signs in or connects an
// account again and when they refresh their calendars. Best effort: an event that still can't be
// removed stays marked for next time; one that's already gone counts as removed.
export async function retryEventRemovals(db: Db, providers: CalendarProviders, hostId: string): Promise<void> {
  const pending = await db.booking.findMany({
    where: { hostId, stillOnCalendar: true, externalEventId: { not: null }, calendar: { connection: { status: 'ACTIVE' } } },
    select: { id: true, externalEventId: true, calendar: { select: calendarSelect } },
  });
  for (const { id, externalEventId, calendar } of pending) {
    if (!calendar || !externalEventId) continue;
    try {
      await providerFor(providers, calendar.connection).deleteEvent(calendar.connection, calendar.externalCalendarId, externalEventId);
      await db.booking.update({ where: { id }, data: { stillOnCalendar: false } });
    } catch (error) {
      if (!(error instanceof CalendarProviderError)) throw error;
      console.error(`Still can't remove the event of cancelled booking ${id}: ${error.kind}`);
    }
  }
}

function assertChangeable(booking: { status: string; startsAt: Date }, now: number): void {
  if (booking.status === 'CANCELLED') throw new HttpError(409, BOOKING_CANCELLED);
  if (booking.startsAt.getTime() <= now) throw new HttpError(409, ALREADY_STARTED);
}

// The host fields booking changes need: their name for messages, their settings for the slot check.
export const bookingHostFields = {
  id: true,
  name: true,
  isDemo: true,
  handle: true,
  timeZone: true,
  bufferBeforeMinutes: true,
  bufferAfterMinutes: true,
  minNoticeMinutes: true,
  horizonDays: true,
  maxPerDay: true,
} as const;

// A guest's booking, by the token from their manage link (only its hash is stored).
export function findByManageToken(db: Db, token: string) {
  return db.booking.findUnique({
    where: { manageTokenHash: hashToken(token) },
    include: { eventType: { select: { title: true, slug: true, slotStepMinutes: true, user: { select: bookingHostFields } } } },
  });
}
