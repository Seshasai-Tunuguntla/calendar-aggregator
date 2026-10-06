import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking, createEventType, createUser } from '../helpers/factories.ts';

const db = useTestDatabase();

// The constraints added by hand to the migrations, exactly as Postgres reports them after every
// migration has run. If a later migration drops, renames or weakens one (for example removes the
// WHERE clause, or changes '[)' to '[]'), this test fails.
const HAND_WRITTEN_CONSTRAINTS: Record<string, string> = {
  Booking_no_overlapping_confirmed:
    `EXCLUDE USING gist ("hostId" WITH =, tstzrange("startsAt", "endsAt", '[)'::text) WITH &&) WHERE ((status = 'CONFIRMED'::"BookingStatus"))`,
  Booking_ends_after_start_check: 'CHECK (("endsAt" > "startsAt"))',
  Booking_cancelled_at_check: `CHECK (((status = 'CANCELLED'::"BookingStatus") = ("cancelledAt" IS NOT NULL)))`,
  Booking_still_on_calendar_check: `CHECK (((NOT "stillOnCalendar") OR (status = 'CANCELLED'::"BookingStatus")))`,
  AvailabilityRule_no_overlap: 'EXCLUDE USING gist ("userId" WITH =, weekday WITH =, int4range("startMinute", "endMinute") WITH &&)',
  AvailabilityRule_weekday_check: 'CHECK (((weekday >= 1) AND (weekday <= 7)))',
  AvailabilityRule_minutes_check: 'CHECK (((0 <= "startMinute") AND ("startMinute" < "endMinute") AND ("endMinute" <= 1440)))',
  User_settings_check:
    'CHECK (((("bufferBeforeMinutes" >= 0) AND ("bufferBeforeMinutes" <= 240)) AND (("bufferAfterMinutes" >= 0) AND ("bufferAfterMinutes" <= 240)) AND (("minNoticeMinutes" >= 0) AND ("minNoticeMinutes" <= 43200)) AND (("horizonDays" >= 1) AND ("horizonDays" <= 365)) AND (("maxPerDay" IS NULL) OR (("maxPerDay" >= 1) AND ("maxPerDay" <= 50)))))',
  User_handle_check: `CHECK ((handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'::text))`,
  User_email_lowercase_check: 'CHECK ((email = lower(email)))',
  EventType_minutes_check:
    'CHECK (((("durationMinutes" >= 5) AND ("durationMinutes" <= 720)) AND (("slotStepMinutes" >= 5) AND ("slotStepMinutes" <= 240))))',
  EventType_slug_check: `CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'::text))`,
  DemoBusyEvent_ends_after_start_check: 'CHECK (("endsAt" > "startsAt"))',
  DemoState_single_row_check: 'CHECK ((id = 1))',
};

// The Postgres error a raw statement fails with, so tests can name the constraint that fired.
async function violation(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    return String((error as Error).message);
  }
  return 'no error';
}

async function hostWithEventType() {
  const host = await createUser(db);
  const eventType = await createEventType(db, host.id);
  return { host, eventType, book: (start: string, end: string, status?: 'CONFIRMED' | 'CANCELLED') =>
    createBooking(db, { eventTypeId: eventType.id, hostId: host.id, start, end, ...(status ? { status } : {}) }) };
}

describe('hand-written constraints after all migrations', () => {
  it('all exist with exactly the expected definitions', async () => {
    const rows = await db.$queryRaw<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype IN ('c', 'x')`;
    expect(Object.fromEntries(rows.map((r) => [r.name, r.definition]))).toEqual(HAND_WRITTEN_CONSTRAINTS);
  });

  it('have the btree_gist extension the exclusion constraints need', async () => {
    const rows = await db.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(rows).toHaveLength(1);
  });
});

describe('Booking_no_overlapping_confirmed (double booking)', () => {
  it('rejects a second confirmed booking that overlaps the first', async () => {
    const { book } = await hostWithEventType();
    await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    const error = await violation(book('2026-10-12T09:15Z', '2026-10-12T09:45Z'));
    expect(error).toContain('23P01');
    expect(error).toContain('Booking_no_overlapping_confirmed');
  });

  it('rejects a booking inside another, and an exact duplicate', async () => {
    const { book } = await hostWithEventType();
    await book('2026-10-12T09:00Z', '2026-10-12T10:00Z');
    expect(await violation(book('2026-10-12T09:15Z', '2026-10-12T09:30Z'))).toContain('Booking_no_overlapping_confirmed');
    expect(await violation(book('2026-10-12T09:00Z', '2026-10-12T10:00Z'))).toContain('Booking_no_overlapping_confirmed');
  });

  it('allows touching bookings: one ends at 09:30, the next starts at 09:30', async () => {
    const { book } = await hostWithEventType();
    await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    await expect(book('2026-10-12T09:30Z', '2026-10-12T10:00Z')).resolves.toBeDefined();
  });

  it('ignores cancelled bookings, so their time can be booked again', async () => {
    const { book } = await hostWithEventType();
    await book('2026-10-12T09:00Z', '2026-10-12T09:30Z', 'CANCELLED');
    await expect(book('2026-10-12T09:00Z', '2026-10-12T09:30Z')).resolves.toBeDefined();
  });

  it('frees the time when a confirmed booking is cancelled', async () => {
    const { book } = await hostWithEventType();
    const first = await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    await db.booking.update({ where: { id: first.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await expect(book('2026-10-12T09:00Z', '2026-10-12T09:30Z')).resolves.toBeDefined();
  });

  it('only compares bookings of the same host', async () => {
    const a = await hostWithEventType();
    const b = await hostWithEventType();
    await a.book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    await expect(b.book('2026-10-12T09:00Z', '2026-10-12T09:30Z')).resolves.toBeDefined();
  });

  it('compares real instants, whatever the session time zone', async () => {
    // One transaction = one connection, so SET LOCAL really applies to both inserts (a plain SET
    // would only change one pooled connection). 09:00-09:30 UTC is 14:30-15:00 in India; if
    // timestamps were stored as wall-clock times, the 14:45 IST booking would miss the overlap.
    const { host, eventType } = await hostWithEventType();
    const insert = (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], start: string, end: string, token: string) =>
      tx.booking.create({
        data: { eventTypeId: eventType.id, hostId: host.id, guestName: 'G', guestEmail: 'g@example.com', guestTimeZone: 'UTC',
          startsAt: new Date(start), endsAt: new Date(end), manageTokenHash: token },
      });
    const error = await violation(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
        const [{ zone }] = await tx.$queryRaw<[{ zone: string }]>`SELECT current_setting('TimeZone') AS zone`;
        expect(zone).toBe('Asia/Kolkata');
        await insert(tx, '2026-10-12T09:00Z', '2026-10-12T09:30Z', 'first');
        await insert(tx, '2026-10-12T14:45+05:30', '2026-10-12T15:15+05:30', 'second');
      }),
    );
    expect(error).toContain('Booking_no_overlapping_confirmed');
  });
});

describe('other booking constraints', () => {
  it('rejects a booking that ends before it starts', async () => {
    const { book } = await hostWithEventType();
    expect(await violation(book('2026-10-12T10:00Z', '2026-10-12T09:00Z'))).toContain('Booking_ends_after_start_check');
  });

  it('requires cancelledAt exactly when the booking is cancelled', async () => {
    const { book } = await hostWithEventType();
    const booking = await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    expect(await violation(db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } }))).toContain('Booking_cancelled_at_check');
    expect(await violation(db.booking.update({ where: { id: booking.id }, data: { cancelledAt: new Date() } }))).toContain('Booking_cancelled_at_check');
  });

  it('only lets a cancelled booking be "still on the calendar"', async () => {
    const { book } = await hostWithEventType();
    const booking = await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    expect(await violation(db.booking.update({ where: { id: booking.id }, data: { stillOnCalendar: true } }))).toContain('Booking_still_on_calendar_check');
    await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), stillOnCalendar: true } });
  });

  it("rejects a booking whose hostId isn't the event type's owner (composite foreign key)", async () => {
    const { eventType } = await hostWithEventType();
    const stranger = await createUser(db);
    const error = await violation(createBooking(db, { eventTypeId: eventType.id, hostId: stranger.id, start: '2026-10-12T09:00Z', end: '2026-10-12T09:30Z' }));
    expect(error).toContain('Booking_eventTypeId_hostId_fkey');
  });

  it("won't delete an event type that has bookings", async () => {
    const { eventType, book } = await hostWithEventType();
    await book('2026-10-12T09:00Z', '2026-10-12T09:30Z');
    expect(await violation(db.eventType.delete({ where: { id: eventType.id } }))).toContain('Booking_eventTypeId_hostId_fkey');
  });
});

const rule = (userId: string, weekday: number, startMinute: number, endMinute: number) =>
  db.availabilityRule.create({ data: { userId, weekday, startMinute, endMinute } });

describe('AvailabilityRule constraints', () => {
  it('rejects overlapping rules on the same weekday, but not touching ones or other weekdays', async () => {
    const host = await createUser(db);
    await rule(host.id, 1, 540, 720);
    expect(await violation(rule(host.id, 1, 660, 840))).toContain('AvailabilityRule_no_overlap');
    await expect(rule(host.id, 1, 720, 1020)).resolves.toBeDefined();
    await expect(rule(host.id, 2, 540, 720)).resolves.toBeDefined();
  });

  it("allows the same hours for different hosts", async () => {
    const [a, b] = [await createUser(db), await createUser(db)];
    await rule(a.id, 1, 540, 1020);
    await expect(rule(b.id, 1, 540, 1020)).resolves.toBeDefined();
  });

  it('rejects an invalid weekday, a rule crossing midnight, and minutes outside the day', async () => {
    const host = await createUser(db);
    expect(await violation(rule(host.id, 0, 540, 600))).toContain('AvailabilityRule_weekday_check');
    expect(await violation(rule(host.id, 8, 540, 600))).toContain('AvailabilityRule_weekday_check');
    expect(await violation(rule(host.id, 1, 1320, 120))).toContain('AvailabilityRule_minutes_check');
    expect(await violation(rule(host.id, 1, 600, 600))).toContain('AvailabilityRule_minutes_check');
    expect(await violation(rule(host.id, 1, 0, 1441))).toContain('AvailabilityRule_minutes_check');
  });
});

describe('User and EventType constraints', () => {
  it('rejects handles that would make bad URLs', async () => {
    for (const handle of ['ab', 'Priya', '-priya', 'priya-', 'pri ya', 'p'.repeat(31)]) {
      expect(await violation(createUser(db, { handle })), handle).toContain('User_handle_check');
    }
    await expect(createUser(db, { handle: 'priya-sharma-2' })).resolves.toBeDefined();
  });

  it('rejects an email that is not lowercased', async () => {
    expect(await violation(createUser(db, { email: 'Priya@Example.com' }))).toContain('User_email_lowercase_check');
  });

  it('rejects settings out of range', async () => {
    for (const settings of [{ bufferBeforeMinutes: -1 }, { bufferAfterMinutes: 241 }, { minNoticeMinutes: 43201 }, { horizonDays: 0 }, { maxPerDay: 0 }]) {
      expect(await violation(createUser(db, settings)), JSON.stringify(settings)).toContain('User_settings_check');
    }
  });

  it('rejects event types with silly durations or steps, or a bad slug', async () => {
    const host = await createUser(db);
    const create = (data: { slug?: string; durationMinutes?: number; slotStepMinutes?: number }) =>
      db.eventType.create({ data: { userId: host.id, title: 'x', slug: 'call', durationMinutes: 30, slotStepMinutes: 30, ...data } });
    expect(await violation(create({ durationMinutes: 4 }))).toContain('EventType_minutes_check');
    expect(await violation(create({ slotStepMinutes: 0 }))).toContain('EventType_minutes_check');
    expect(await violation(create({ slug: 'Call Me' }))).toContain('EventType_slug_check');
  });
});

describe('DemoState_single_row_check', () => {
  it('keeps one demo reset time for every server instance: a second row is rejected', async () => {
    await db.demoState.create({ data: { id: 1, lastResetAt: new Date() } });
    expect(await violation(db.demoState.create({ data: { id: 2, lastResetAt: new Date() } }))).toContain('DemoState_single_row_check');
  });
});
