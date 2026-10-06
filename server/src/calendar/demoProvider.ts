import type { BusyAccess } from '@prisma/client';
import type { Interval } from '@calendar-aggregator/shared/slots';
import type { Db } from '../db.ts';
import {
  CalendarProviderError,
  type CalendarProvider,
  type ConnectionRef,
  type ExternalCalendar,
  type NewCalendarEvent,
} from './provider.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Like Google, the demo can't read busy times from holiday calendars (Google's freeBusy answers
// notFound for them; checked on a real account in phase 5). The demo's holiday calendar uses
// Google's id for it, so it behaves the same way.
const HOLIDAY_CALENDAR = /#holiday@group\.v\.calendar\.google\.com$/;

// The demo provider: calendars are Calendar rows of a DEMO connection, and their events are
// DemoBusyEvent rows (start and end only, the same information we read from Google). Creating an
// event adds a row, so a booking with the demo host makes that time busy, as it would in Google.
export class DemoCalendarProvider implements CalendarProvider {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listCalendars(connection: ConnectionRef): Promise<ExternalCalendar[]> {
    assertDemo(connection);
    const calendars = await this.#db.calendar.findMany({
      where: { connectionId: connection.id },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    return calendars.map(({ externalCalendarId, name, isPrimary, canCreateEvents }) => ({ externalCalendarId, name, isPrimary, canCreateEvents }));
  }

  async getBusyIntervals(connection: ConnectionRef, externalCalendarIds: readonly string[], range: Interval): Promise<Interval[]> {
    assertDemo(connection);
    if (externalCalendarIds.length === 0 || range.end <= range.start) return [];
    const holiday = externalCalendarIds.find((id) => HOLIDAY_CALENDAR.test(id));
    if (holiday) throw new CalendarProviderError('not_found', "Can't read free/busy for a calendar (notFound)", { externalCalendarId: holiday });

    const events = await this.#db.demoBusyEvent.findMany({
      where: {
        calendar: { connectionId: connection.id, externalCalendarId: { in: [...externalCalendarIds] } },
        // Overlaps [start, end): starts before the range ends and ends after it starts.
        startsAt: { lt: new Date(range.end) },
        endsAt: { gt: new Date(range.start) },
      },
      select: { startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    return events.map((e) => ({ start: e.startsAt.getTime(), end: e.endsAt.getTime() }));
  }

  async checkBusyAccess(connection: ConnectionRef, externalCalendarIds: readonly string[]): Promise<Map<string, BusyAccess>> {
    assertDemo(connection);
    const existing = await this.#db.calendar.findMany({
      where: { connectionId: connection.id, externalCalendarId: { in: [...externalCalendarIds] } },
      select: { externalCalendarId: true },
    });
    const known = new Set(existing.map((c) => c.externalCalendarId));
    return new Map(externalCalendarIds.map((id) => [id, known.has(id) && !HOLIDAY_CALENDAR.test(id) ? 'READABLE' : 'UNREADABLE']));
  }

  async createEvent(connection: ConnectionRef, event: NewCalendarEvent): Promise<{ externalEventId: string }> {
    assertDemo(connection);
    const calendar = await this.#db.calendar.findUnique({
      where: { connectionId_externalCalendarId: { connectionId: connection.id, externalCalendarId: event.externalCalendarId } },
    });
    if (!calendar) throw new CalendarProviderError('not_found', 'Calendar not found', { externalCalendarId: event.externalCalendarId });
    if (!calendar.canCreateEvents) {
      throw new CalendarProviderError('not_found', "Events can't be created in this calendar", { externalCalendarId: event.externalCalendarId });
    }

    // The idempotency key is the event's id, so creating it again returns the same event. Only
    // the time is kept: summary, description and attendees are deliberately not stored.
    const created = await this.#db.demoBusyEvent.upsert({
      where: { id: event.idempotencyKey },
      create: { id: event.idempotencyKey, calendarId: calendar.id, startsAt: event.start, endsAt: event.end },
      update: {},
    });
    return { externalEventId: created.id };
  }

  eventIdFor(idempotencyKey: string): string {
    return idempotencyKey;
  }

  async moveEvent(connection: ConnectionRef, externalCalendarId: string, externalEventId: string, start: Date, end: Date): Promise<void> {
    assertDemo(connection);
    const moved = UUID.test(externalEventId)
      ? await this.#db.demoBusyEvent.updateMany({
          where: { id: externalEventId, calendar: { connectionId: connection.id, externalCalendarId } },
          data: { startsAt: start, endsAt: end },
        })
      : { count: 0 };
    if (moved.count === 0) throw new CalendarProviderError('not_found', 'Event not found', { externalCalendarId });
  }

  async deleteEvent(connection: ConnectionRef, externalCalendarId: string, externalEventId: string): Promise<void> {
    assertDemo(connection);
    // Not a demo event id at all: nothing to delete (and Postgres would reject it as a uuid).
    if (!UUID.test(externalEventId)) return;
    await this.#db.demoBusyEvent.deleteMany({
      where: { id: externalEventId, calendar: { connectionId: connection.id, externalCalendarId } },
    });
  }
}

function assertDemo(connection: ConnectionRef): void {
  if (connection.provider !== 'DEMO') {
    throw new Error(`DemoCalendarProvider can't serve a ${connection.provider} connection`);
  }
}
