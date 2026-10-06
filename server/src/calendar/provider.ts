import type { ProviderKind } from '@prisma/client';
import type { Interval } from '@calendar-aggregator/shared/slots';

// All calendar access goes through this interface. Two implementations:
// - GoogleCalendarProvider (phase 5): the real Google Calendar API.
// - DemoCalendarProvider: busy events stored in our own database, for tests and the public demo,
//   so neither needs Google access or the network.
// Routes and services never know which one they're talking to.

// The parts of a CalendarConnection row a provider needs. Google's provider loads (and refreshes)
// the connection's tokens itself; callers never handle them.
export interface ConnectionRef {
  id: string;
  userId: string;
  provider: ProviderKind;
}

export interface ExternalCalendar {
  externalCalendarId: string;
  name: string;
  isPrimary: boolean;
}

export interface NewCalendarEvent {
  /** The provider's id of the calendar to create the event in. */
  externalCalendarId: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  /** Google emails the invitation to these attendees. */
  attendees: readonly { email: string; name: string }[];
}

export interface CalendarProvider {
  listCalendars(connection: ConnectionRef): Promise<ExternalCalendar[]>;
  /**
   * Busy time on the given calendars that overlaps `range` (UTC epoch ms): intervals only, never
   * titles or attendees. May overlap and come in any order; the slot algorithm merges them.
   */
  getBusyIntervals(connection: ConnectionRef, externalCalendarIds: readonly string[], range: Interval): Promise<Interval[]>;
  createEvent(connection: ConnectionRef, event: NewCalendarEvent): Promise<{ externalEventId: string }>;
  /** Idempotent: deleting an event that's already gone succeeds. */
  deleteEvent(connection: ConnectionRef, externalCalendarId: string, externalEventId: string): Promise<void>;
}

// What went wrong, in terms the app can act on:
// - auth: access expired or was revoked; the connection needs reconnecting.
// - rate_limited: the provider asked us to slow down; try again later.
// - not_found: the calendar (or event) doesn't exist, or isn't this connection's.
// - unavailable: anything else (network, provider outage).
export type CalendarErrorKind = 'auth' | 'rate_limited' | 'not_found' | 'unavailable';

export class CalendarProviderError extends Error {
  readonly kind: CalendarErrorKind;

  constructor(kind: CalendarErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarProviderError';
    this.kind = kind;
  }
}
