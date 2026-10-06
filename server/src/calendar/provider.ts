import type { BusyAccess, ProviderKind } from '@prisma/client';
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
  /** The user owns it, so booking events can be created in it. */
  canCreateEvents: boolean;
}

export interface NewCalendarEvent {
  /**
   * A UUID chosen by us (the booking's id). Creating an event with the same key twice creates it
   * once, so a retry after a timeout can't produce a duplicate invitation.
   */
  idempotencyKey: string;
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
  /**
   * Whether busy times can be read from each calendar: READABLE, UNREADABLE (the provider answered
   * that it can't serve this calendar: permanent, e.g. Google's holiday calendars) or UNKNOWN (that
   * calendar's check failed for a temporary reason). A failure of the whole request (network,
   * rate limits, expired access) throws a CalendarProviderError instead.
   */
  checkBusyAccess(connection: ConnectionRef, externalCalendarIds: readonly string[]): Promise<Map<string, BusyAccess>>;
  createEvent(connection: ConnectionRef, event: NewCalendarEvent): Promise<{ externalEventId: string }>;
  /**
   * The id createEvent gives the event for this idempotency key. Lets a caller clean up after a
   * create whose outcome is unknown (it may have reached the provider before failing).
   */
  eventIdFor(idempotencyKey: string): string;
  /** Moves an event to a new time; the attendees are told. Throws not_found if it's gone. */
  moveEvent(connection: ConnectionRef, externalCalendarId: string, externalEventId: string, start: Date, end: Date): Promise<void>;
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
  /** The calendar the error is about, when it's about one (e.g. one that can't be read). */
  readonly externalCalendarId: string | undefined;

  constructor(kind: CalendarErrorKind, message: string, options?: { cause?: unknown; externalCalendarId?: string }) {
    super(message, options);
    this.name = 'CalendarProviderError';
    this.kind = kind;
    this.externalCalendarId = options?.externalCalendarId;
  }
}
