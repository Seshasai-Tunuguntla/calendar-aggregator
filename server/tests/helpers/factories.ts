import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db.ts';

// Small builders for test rows. Each returns what was created; overrides change any field.

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export function createUser(db: Db, overrides: Partial<Parameters<Db['user']['create']>[0]['data']> = {}) {
  const id = unique();
  return db.user.create({
    data: { name: 'Host', email: `host-${id}@example.com`, handle: `host-${id}`, timeZone: 'Asia/Kolkata', ...overrides },
  });
}

export function createEventType(db: Db, userId: string, overrides: { slug?: string; durationMinutes?: number } = {}) {
  return db.eventType.create({
    data: { userId, slug: overrides.slug ?? `call-${unique()}`, title: 'Call', durationMinutes: overrides.durationMinutes ?? 30, slotStepMinutes: 30 },
  });
}

export function createBooking(
  db: Db,
  { eventTypeId, hostId, start, end, status = 'CONFIRMED' }: { eventTypeId: string; hostId: string; start: string; end: string; status?: 'CONFIRMED' | 'CANCELLED' },
) {
  return db.booking.create({
    data: {
      eventTypeId,
      hostId,
      guestName: 'Guest',
      guestEmail: 'guest@example.com',
      guestTimeZone: 'America/New_York',
      startsAt: new Date(start),
      endsAt: new Date(end),
      status,
      cancelledAt: status === 'CANCELLED' ? new Date(start) : null,
      manageTokenHash: randomUUID(),
    },
  });
}

// A demo connection with the given calendars (by external id).
export async function createDemoConnection(db: Db, userId: string, calendarIds: readonly string[] = ['work', 'personal']) {
  return db.calendarConnection.create({
    data: {
      userId,
      provider: 'DEMO',
      externalAccountId: `demo-${unique()}`,
      accountEmail: 'demo@example.com',
      calendars: {
        create: calendarIds.map((externalCalendarId, i) => ({ externalCalendarId, name: externalCalendarId, isPrimary: i === 0, canCreateEvents: externalCalendarId !== 'holidays' })),
      },
    },
    include: { calendars: true },
  });
}
