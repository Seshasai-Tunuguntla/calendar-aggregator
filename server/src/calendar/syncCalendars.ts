import type { BusyAccess, ProviderKind } from '@prisma/client';
import type { Db } from '../db.ts';
import { invalidateBusyCache } from './busyCache.ts';
import { CalendarProviderError, type CalendarProvider, type ConnectionRef } from './provider.ts';

export type CalendarProviders = Partial<Record<ProviderKind, CalendarProvider>>;

export function providerFor(providers: CalendarProviders, connection: ConnectionRef): CalendarProvider {
  const provider = providers[connection.provider];
  // E.g. a Google connection while Google sign-in isn't configured locally: as if Google were down.
  if (!provider) throw new CalendarProviderError('unavailable', `No calendar provider configured for ${connection.provider}`);
  return provider;
}

// Copies a connection's calendar list into Calendar rows, so the host can choose which count as
// busy, and checks which of them the provider will give busy times for (one request).
//
// New calendars count as busy only if the user owns them and they're not known to be unreadable:
// subscribed ones (holidays, birthdays, a colleague's shared calendar) usually shouldn't block
// bookings, and the host can tick them. Later syncs keep the host's choices, update names and
// access, and remove calendars gone from the provider.
//
// If the access check fails as a whole (Google down, rate limited), the list is still saved and
// every calendar's access is UNKNOWN: a temporary failure never marks a calendar unreadable.
// Listing failures throw (CalendarProviderError).
export async function syncCalendars(db: Db, provider: CalendarProvider, connection: ConnectionRef): Promise<void> {
  const external = await provider.listCalendars(connection);
  const ids = external.map((calendar) => calendar.externalCalendarId);

  let access = new Map<string, BusyAccess>();
  try {
    access = await provider.checkBusyAccess(connection, ids);
  } catch (error) {
    if (!(error instanceof CalendarProviderError)) throw error;
  }

  await db.$transaction([
    db.calendar.deleteMany({ where: { connectionId: connection.id, externalCalendarId: { notIn: ids } } }),
    ...external.map((calendar) => {
      const busyAccess = access.get(calendar.externalCalendarId) ?? 'UNKNOWN';
      return db.calendar.upsert({
        where: { connectionId_externalCalendarId: { connectionId: connection.id, externalCalendarId: calendar.externalCalendarId } },
        create: { connectionId: connection.id, ...calendar, busyAccess, countsAsBusy: calendar.canCreateEvents && busyAccess !== 'UNREADABLE' },
        update: { name: calendar.name, isPrimary: calendar.isPrimary, canCreateEvents: calendar.canCreateEvents, busyAccess },
      });
    }),
  ]);
  await invalidateBusyCache(db, connection.userId);
}

// Syncs every active connection of a user (the calendars page's "refresh"). A connection that
// can't be listed right now keeps its calendars, marked UNKNOWN ("can't check right now"); one
// whose access expired is marked NEEDS_RECONNECT by the token service and left as it is.
export async function syncUserCalendars(db: Db, providers: CalendarProviders, userId: string): Promise<void> {
  const connections = await db.calendarConnection.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { id: true, userId: true, provider: true },
  });
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await syncCalendars(db, providerFor(providers, connection), connection);
      } catch (error) {
        if (!(error instanceof CalendarProviderError)) throw error;
        if (error.kind !== 'auth') await db.calendar.updateMany({ where: { connectionId: connection.id }, data: { busyAccess: 'UNKNOWN' } });
      }
    }),
  );
}
