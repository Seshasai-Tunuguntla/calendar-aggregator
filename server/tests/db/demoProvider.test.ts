import { describe, expect, it } from 'vitest';
import { DemoCalendarProvider } from '../../src/calendar/demoProvider.ts';
import { CalendarProviderError, type ConnectionRef } from '../../src/calendar/provider.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createDemoConnection, createUser } from '../helpers/factories.ts';

const db = useTestDatabase();
const provider = new DemoCalendarProvider(db);

const ms = (iso: string) => Date.parse(iso);
const range = (from: string, to: string) => ({ start: ms(from), end: ms(to) });

async function setup() {
  const host = await createUser(db);
  const connection = await createDemoConnection(db, host.id, ['work', 'personal', 'holidays']);
  const calendarId = (external: string) => connection.calendars.find((c) => c.externalCalendarId === external)?.id ?? '';
  const busy = (calendar: string, from: string, to: string) =>
    db.demoBusyEvent.create({ data: { calendarId: calendarId(calendar), startsAt: new Date(from), endsAt: new Date(to) } });
  const ref: ConnectionRef = { id: connection.id, userId: host.id, provider: 'DEMO' };
  return { host, connection, ref, busy };
}

describe('DemoCalendarProvider', () => {
  it("lists the connection's calendars, primary first", async () => {
    const { ref } = await setup();
    expect(await provider.listCalendars(ref)).toEqual([
      { externalCalendarId: 'work', name: 'work', isPrimary: true },
      { externalCalendarId: 'holidays', name: 'holidays', isPrimary: false },
      { externalCalendarId: 'personal', name: 'personal', isPrimary: false },
    ]);
  });

  describe('getBusyIntervals', () => {
    it('returns busy time on the chosen calendars that overlaps the range, as epoch ms', async () => {
      const { ref, busy } = await setup();
      await busy('work', '2026-10-12T04:00Z', '2026-10-12T05:00Z');
      await busy('personal', '2026-10-12T07:00Z', '2026-10-12T08:00Z');
      await busy('holidays', '2026-10-12T00:00Z', '2026-10-13T00:00Z');

      const intervals = await provider.getBusyIntervals(ref, ['work', 'personal'], range('2026-10-12T00:00Z', '2026-10-13T00:00Z'));
      expect(intervals).toEqual([range('2026-10-12T04:00Z', '2026-10-12T05:00Z'), range('2026-10-12T07:00Z', '2026-10-12T08:00Z')]);
    });

    it('includes events that only partly overlap the range, and excludes ones that only touch it', async () => {
      const { ref, busy } = await setup();
      await busy('work', '2026-10-11T23:00Z', '2026-10-12T01:00Z'); // runs into the range
      await busy('work', '2026-10-12T23:30Z', '2026-10-13T02:00Z'); // starts inside it
      await busy('work', '2026-10-11T22:00Z', '2026-10-12T00:00Z'); // ends exactly at its start
      await busy('work', '2026-10-13T00:00Z', '2026-10-13T01:00Z'); // starts exactly at its end

      const intervals = await provider.getBusyIntervals(ref, ['work'], range('2026-10-12T00:00Z', '2026-10-13T00:00Z'));
      expect(intervals).toEqual([range('2026-10-11T23:00Z', '2026-10-12T01:00Z'), range('2026-10-12T23:30Z', '2026-10-13T02:00Z')]);
    });

    it('returns nothing for no calendars or an empty range', async () => {
      const { ref, busy } = await setup();
      await busy('work', '2026-10-12T04:00Z', '2026-10-12T05:00Z');
      expect(await provider.getBusyIntervals(ref, [], range('2026-10-12T00:00Z', '2026-10-13T00:00Z'))).toEqual([]);
      expect(await provider.getBusyIntervals(ref, ['work'], range('2026-10-12T05:00Z', '2026-10-12T05:00Z'))).toEqual([]);
    });

    it("never returns another connection's events, even for a calendar with the same id", async () => {
      const mine = await setup();
      const theirs = await setup();
      await theirs.busy('work', '2026-10-12T04:00Z', '2026-10-12T05:00Z');
      expect(await provider.getBusyIntervals(mine.ref, ['work'], range('2026-10-12T00:00Z', '2026-10-13T00:00Z'))).toEqual([]);
    });
  });

  describe('createEvent and deleteEvent', () => {
    const event = {
      externalCalendarId: 'work',
      start: new Date('2026-10-12T09:00Z'),
      end: new Date('2026-10-12T09:30Z'),
      summary: '30-min call with Alex',
      description: 'Booked through the demo',
      attendees: [{ email: 'alex@example.com', name: 'Alex' }],
    };

    it('creates an event that then counts as busy, storing only its time', async () => {
      const { ref } = await setup();
      const { externalEventId } = await provider.createEvent(ref, event);

      expect(await provider.getBusyIntervals(ref, ['work'], range('2026-10-12T00:00Z', '2026-10-13T00:00Z'))).toEqual([
        range('2026-10-12T09:00Z', '2026-10-12T09:30Z'),
      ]);
      const stored = await db.demoBusyEvent.findUniqueOrThrow({ where: { id: externalEventId } });
      expect(Object.keys(stored).toSorted()).toEqual(['calendarId', 'endsAt', 'id', 'startsAt']);
    });

    it("refuses to create an event in a calendar that isn't this connection's", async () => {
      const mine = await setup();
      const error = await provider.createEvent(mine.ref, { ...event, externalCalendarId: 'nope' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CalendarProviderError);
      expect(error).toMatchObject({ kind: 'not_found' });
    });

    it('deletes an event, and deleting it again (or a made-up id) still succeeds', async () => {
      const { ref } = await setup();
      const { externalEventId } = await provider.createEvent(ref, event);
      await provider.deleteEvent(ref, 'work', externalEventId);
      await provider.deleteEvent(ref, 'work', externalEventId);
      await provider.deleteEvent(ref, 'work', 'not-a-uuid');
      expect(await db.demoBusyEvent.count()).toBe(0);
    });

    it("can't delete another connection's event", async () => {
      const mine = await setup();
      const theirs = await setup();
      const { externalEventId } = await provider.createEvent(theirs.ref, event);
      await provider.deleteEvent(mine.ref, 'work', externalEventId);
      expect(await db.demoBusyEvent.count()).toBe(1);
    });
  });

  it('refuses to serve a Google connection', async () => {
    const { ref } = await setup();
    await expect(provider.listCalendars({ ...ref, provider: 'GOOGLE' })).rejects.toThrow("can't serve a GOOGLE connection");
  });
});
