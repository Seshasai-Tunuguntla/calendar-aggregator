import type { ProviderKind } from '@prisma/client';
import type { Db } from '../db.ts';
import type { CalendarProvider, ConnectionRef } from './provider.ts';

export type CalendarProviders = Partial<Record<ProviderKind, CalendarProvider>>;

export function providerFor(providers: CalendarProviders, connection: ConnectionRef): CalendarProvider {
  const provider = providers[connection.provider];
  if (!provider) throw new Error(`No calendar provider configured for ${connection.provider}`);
  return provider;
}

// Copies a connection's calendar list into Calendar rows, so the host can choose which count as
// busy. New calendars count as busy only if the user owns them: subscribed ones (holidays,
// birthdays, a colleague's shared calendar) usually shouldn't block bookings, and the host can
// tick them. On later syncs the host's choices are kept, names and access are updated, and
// calendars gone from the provider are removed.
export async function syncCalendars(db: Db, provider: CalendarProvider, connection: ConnectionRef): Promise<void> {
  const external = await provider.listCalendars(connection);
  const ids = external.map((calendar) => calendar.externalCalendarId);

  await db.$transaction([
    db.calendar.deleteMany({ where: { connectionId: connection.id, externalCalendarId: { notIn: ids } } }),
    ...external.map((calendar) =>
      db.calendar.upsert({
        where: { connectionId_externalCalendarId: { connectionId: connection.id, externalCalendarId: calendar.externalCalendarId } },
        create: { connectionId: connection.id, ...calendar, countsAsBusy: calendar.canCreateEvents },
        update: { name: calendar.name, isPrimary: calendar.isPrimary, canCreateEvents: calendar.canCreateEvents },
      }),
    ),
  ]);
}
