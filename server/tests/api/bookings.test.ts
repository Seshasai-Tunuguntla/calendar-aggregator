import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calendarsResponseSchema,
  createBookingResponseSchema,
  guestBookingResponseSchema,
  hostBookingResponseSchema,
  hostBookingsResponseSchema,
  slotsResponseSchema,
  type Availability,
} from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import type { Timeouts } from '../../src/bookings/timeouts.ts';
import { ALREADY_STARTED, BOOKING_CANCELLED, CANT_MOVE, SLOT_TAKEN, SLOT_UNAVAILABLE } from '../../src/bookings/bookings.ts';
import { googleEventId } from '../../src/calendar/googleProvider.ts';
import { BOOKING_NOT_FOUND } from '../../src/routes/publicBooking.ts';
import { PAGE_SIZE } from '../../src/routes/bookings.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking as insertBooking } from '../helpers/factories.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount, type FakeCalendar } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';

const db = useTestDatabase();

// Monday 12 October 2026, 08:00 in India.
const NOW = new Date('2026-10-12T02:30:00Z');
const HOST: FakeAccount = { sub: '9100000000000000001', email: 'priyanka@gmail.com', name: 'Priyanka Rao' };
const OTHER: FakeAccount = { sub: '9100000000000000002', email: 'other@gmail.com', name: 'Other Host' };
const PAGE = '/api/public/book/priyanka-rao/30-min-call';

const ist = (time: string, date = '2026-10-12') => new Date(`${date}T${time}:00+05:30`).toISOString();
const AT_9 = ist('09:00');
const AT_930 = ist('09:30');
const ALEX = { guestName: 'Alex Kim', guestEmail: 'alex@example.com', guestTimeZone: 'America/New_York' };
const SAM = { guestName: 'Sam Lee', guestEmail: 'sam@example.com', guestTimeZone: 'Europe/London' };

// Monday 09:00-10:00 IST, no buffers or notice: 30-minute slots at 09:00 and 09:30.
const ONE_HOUR: Availability = {
  timeZone: 'Asia/Kolkata',
  rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }],
  settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 30, maxPerDay: null },
};

const PRIMARY: FakeCalendar = { id: HOST.email, summary: HOST.email, accessRole: 'owner', primary: true };
const SIDE: FakeCalendar = { id: 'side@group.calendar.google.com', summary: 'Side', accessRole: 'owner' };
const TEAM: FakeCalendar = { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' };

let google: FakeGoogle;
let clock: number;
const makeApp = (timeouts?: Timeouts) =>
  createApp({
    db,
    production: false,
    rateLimits: false,
    now: () => new Date(clock),
    beforeBookingLock,
    ...(timeouts ? { timeouts } : {}),
    google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep: async () => {} },
  });
// When set, bookings wait just before the host's lock until this many have arrived, so concurrent
// requests have all passed their first check (tests don't depend on timing).
let lineUp: { size: number; waiting: (() => void)[] } | null;
const beforeBookingLock = async () => {
  const line = lineUp;
  if (!line) return;
  await new Promise<void>((resolve) => {
    line.waiting.push(resolve);
    if (line.waiting.length >= line.size) for (const release of line.waiting) release();
  });
};
let app: ReturnType<typeof createApp>;
let host: TestBrowser;
let guest: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  clock = NOW.getTime();
  lineUp = null;
  app = makeApp();
  host = new TestBrowser(app);
  guest = new TestBrowser(app);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setUpHost(availability: Availability = ONE_HOUR, calendars: FakeCalendar[] = [PRIMARY, SIDE, TEAM]) {
  google.setCalendars(HOST.sub, calendars.map((c) => ({ ...c })));
  await signInWithGoogle(host, google, HOST);
  expect((await host.put('/api/availability', availability)).status).toBe(200);
  expect((await host.post('/api/event-types', { slug: '30-min-call', title: '30-min call', durationMinutes: 30, slotStepMinutes: 30 })).status).toBe(201);
}

const book = (start: string, who = ALEX, b = guest) => b.post(`${PAGE}/bookings`, { start, ...who });

async function booked(start: string, who = ALEX) {
  const res = await book(start, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return createBookingResponseSchema.parse(res.body);
}

async function slotStarts() {
  const res = await guest.get(`${PAGE}/slots?from=2026-10-12&to=2026-10-13&tz=Asia/Kolkata`);
  return slotsResponseSchema.parse(res.body).slots.map((s) => s.start);
}

const manage = (token: string) => `/api/public/bookings/${token}`;
const liveEvents = () => [...google.events.values()].filter((e) => !e.deleted);
const freeBusyCalls = () => google.calendarRequests.filter((r) => r.url.endsWith('/freeBusy')).length;

describe('POST /api/public/book/:handle/:slug/bookings', () => {
  it("books a free slot, creates the event on the host's calendar with the guest invited, and hides the slot", async () => {
    await setUpHost();
    expect(await slotStarts()).toEqual([AT_9, AT_930]);
    const { booking, manageToken, managePath } = await booked(AT_9, { ...ALEX, guestEmail: '  Alex@Example.COM ' });

    expect(booking).toEqual({
      status: 'CONFIRMED',
      start: AT_9,
      end: AT_930,
      guestName: 'Alex Kim',
      guestEmail: 'alex@example.com',
      guestTimeZone: 'America/New_York',
      host: { name: 'Priyanka Rao', timeZone: 'Asia/Kolkata' },
      eventType: { title: '30-min call', durationMinutes: 30, bookingPath: '/book/priyanka-rao/30-min-call' },
      canChange: true,
    });
    expect(manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(managePath).toBe(`/booking/${manageToken}`);

    // Only the token's hash is stored; the event is on the host's primary calendar.
    const row = await db.booking.findFirstOrThrow({ include: { calendar: true } });
    expect(row.manageTokenHash).toBe(createHash('sha256').update(manageToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(manageToken);
    expect(row.calendar?.externalCalendarId).toBe(HOST.email);
    expect(row.externalEventId).toBe(googleEventId(row.id));
    expect(google.events.get(row.externalEventId ?? '')).toMatchObject({
      calendarId: HOST.email,
      summary: '30-min call with Alex Kim',
      start: AT_9,
      end: AT_930,
      attendees: [{ email: 'alex@example.com', displayName: 'Alex Kim' }],
      sendUpdates: 'all',
    });

    // The cached busy time was cleared, so the next guest reads fresh data and sees one slot left.
    const before = freeBusyCalls();
    expect(await slotStarts()).toEqual([AT_930]);
    expect(freeBusyCalls()).toBe(before + 1);
  });

  it("checks the host's calendar fresh before booking, not the 60-second cache", async () => {
    await setUpHost();
    expect(await slotStarts()).toEqual([AT_9, AT_930]);
    google.setCalendars(HOST.sub, [{ ...PRIMARY, busy: [{ start: AT_9, end: AT_930 }] }, SIDE, TEAM]);
    // The cache still offers 09:00, but booking it reads the calendar again.
    expect(await slotStarts()).toEqual([AT_9, AT_930]);
    const res = await book(AT_9);
    expect([res.status, res.body.error]).toEqual([409, SLOT_UNAVAILABLE]);
    expect(await db.booking.count()).toBe(0);
  });

  it.each([
    ['a time between slots', ist('09:10')],
    ['a time outside working hours', ist('11:00')],
    ['a time in the past', ist('07:00')],
    ['a time beyond the booking horizon', ist('09:00', '2026-11-16')],
    ['a time already booked', AT_9],
  ])('refuses %s (409)', async (name, start) => {
    await setUpHost();
    if (name === 'a time already booked') await booked(AT_9, SAM);
    const res = await book(start);
    expect([res.status, res.body.error]).toEqual([409, SLOT_UNAVAILABLE]);
    expect(await db.booking.count({ where: { guestEmail: ALEX.guestEmail } })).toBe(0);
  });

  it.each([
    ['no name', { guestName: '  ' }, 'Enter your name'],
    ['an invalid email', { guestEmail: 'alex@' }, 'Enter a valid email address'],
    ['a fixed offset as the time zone', { guestTimeZone: '+05:30' }, 'Unknown time zone'],
    ['a start that is not a time', { start: 'Monday at nine' }, undefined],
  ])('rejects %s (400)', async (_name, change, message) => {
    await setUpHost();
    const res = await guest.post(`${PAGE}/bookings`, { start: AT_9, ...ALEX, ...change });
    expect(res.status).toBe(400);
    expect(message === undefined || res.body.error === message).toBe(true);
  });

  describe('two guests at once', () => {
    it('for the same slot: exactly one gets it, the other is told "That time was just taken"', async () => {
      await setUpHost();
      // Both pass the first check before either takes the lock.
      lineUp = { size: 2, waiting: [] };
      const results = await Promise.all([book(AT_9, ALEX, guest), book(AT_9, SAM, new TestBrowser(app))]);
      expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body).toEqual({ error: SLOT_TAKEN });
      expect(await db.booking.count()).toBe(1);
      expect(liveEvents()).toHaveLength(1);
    });

    it('for the last booking of a day with a daily limit: only one of two different slots is booked', async () => {
      await setUpHost({ ...ONE_HOUR, settings: { ...ONE_HOUR.settings, maxPerDay: 1 } });
      lineUp = { size: 2, waiting: [] };
      const results = await Promise.all([book(AT_9, ALEX, guest), book(AT_930, SAM, new TestBrowser(app))]);
      expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
      expect(await db.booking.count()).toBe(1);
    });
  });

  describe("when the host's calendar can't take the event", () => {
    it('books nothing and says so when Google fails', async () => {
      await setUpHost();
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'events' as const })));
      const res = await book(AT_9);
      expect([res.status, res.body.error]).toEqual([503, "We couldn't add this to Priyanka Rao's calendar, so nothing was booked. Please try again in a few minutes."]);
      expect(await db.booking.count()).toBe(0);
      expect(liveEvents()).toHaveLength(0);
      expect(await slotStarts()).toEqual([AT_9, AT_930]);
    });

    it('withdraws an event Google created even though its answer was lost', async () => {
      await setUpHost();
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 500, reason: 'backendError', only: 'events' as const, afterApplying: true })));
      expect((await book(AT_9)).status).toBe(503);
      expect(await db.booking.count()).toBe(0);
      const [event] = [...google.events.values()];
      expect(event).toMatchObject({ deleted: true, sendUpdates: 'all' });
    });

    it("refuses with 503 when the host's calendars can't be checked (access revoked)", async () => {
      await setUpHost();
      google.revokeAccessTokens();
      google.revokeAll(HOST.sub);
      const res = await book(AT_9);
      expect([res.status, res.body.error]).toEqual([503, "We can't check Priyanka Rao's calendar right now, so this time can't be booked. Please try again in a few minutes."]);
      expect(await db.booking.count()).toBe(0);
    });

    it('refuses with 503 when the host owns no calendar events can go into', async () => {
      await setUpHost();
      await db.calendar.updateMany({ data: { canCreateEvents: false } });
      expect((await book(AT_9)).status).toBe(503);
      expect(await db.booking.count()).toBe(0);
    });
  });

  it("puts the event in the calendar the host chose, which must be one they own", async () => {
    await setUpHost();
    const { calendars } = calendarsResponseSchema.parse((await host.get('/api/calendars')).body);
    const id = (name: string) => calendars.find((c) => c.name === name)?.id ?? '';
    expect(calendarsResponseSchema.parse((await host.get('/api/calendars')).body).bookingCalendarId).toBe(id(HOST.email));

    expect((await host.put('/api/calendars/booking-calendar', { calendarId: id('Team') })).status).toBe(409);
    const res = await host.put('/api/calendars/booking-calendar', { calendarId: id('Side') });
    expect(calendarsResponseSchema.parse(res.body).bookingCalendarId).toBe(id('Side'));
    const other = new TestBrowser(app);
    google.setCalendars(OTHER.sub, [{ id: OTHER.email, summary: OTHER.email, accessRole: 'owner', primary: true }]);
    await signInWithGoogle(other, google, OTHER);
    expect((await other.put('/api/calendars/booking-calendar', { calendarId: id('Side') })).status).toBe(404);

    await booked(AT_9);
    expect(liveEvents().map((e) => e.calendarId)).toEqual([SIDE.id]);
  });

  it('works for the demo host, whose bookings go into the demo Work calendar', async () => {
    await new TestBrowser(app).post('/api/auth/demo');
    const slots = slotsResponseSchema.parse((await guest.get('/api/public/book/priya/30-min-call/slots?from=2026-10-13&to=2026-10-14&tz=Asia/Kolkata')).body).slots;
    const first = slots[0]?.start ?? '';
    const res = await guest.post('/api/public/book/priya/30-min-call/bookings', { start: first, ...ALEX });
    expect(res.status).toBe(201);
    const row = await db.booking.findFirstOrThrow();
    expect(await db.demoBusyEvent.findUnique({ where: { id: row.externalEventId ?? '' }, include: { calendar: true } })).toMatchObject({ calendar: { name: 'Work' } });
    const after = slotsResponseSchema.parse((await guest.get('/api/public/book/priya/30-min-call/slots?from=2026-10-13&to=2026-10-14&tz=Asia/Kolkata')).body).slots;
    expect(after.map((s) => s.start)).not.toContain(first);
  });
});

// The guest cancels while the host's access has expired: allowed, but the event stays.
async function cancelWhileExpired() {
  await setUpHost();
  const { manageToken } = await booked(AT_9);
  google.revokeAccessTokens();
  google.revokeAll(HOST.sub);
  expect((await guest.post(`${manage(manageToken)}/cancel`)).status).toBe(200);
}
const hostList = async () => hostBookingsResponseSchema.parse((await host.get('/api/bookings')).body).bookings;

describe("the guest's manage link", () => {
  it('shows the booking to whoever has the link, and nothing for a wrong one', async () => {
    await setUpHost();
    const { manageToken } = await booked(AT_9);
    const res = await new TestBrowser(app).get(manage(manageToken));
    expect(guestBookingResponseSchema.parse(res.body).booking).toMatchObject({ status: 'CONFIRMED', start: AT_9, guestName: 'Alex Kim', canChange: true });
    expect(JSON.stringify(res.body)).not.toContain(HOST.email);

    for (const wrong of ['A'.repeat(43), 'short', `${manageToken}x`]) {
      const missing = await guest.get(manage(wrong));
      expect([missing.status, missing.body.error]).toEqual([404, BOOKING_NOT_FOUND]);
    }
  });

  describe('cancel', () => {
    it('deletes the event (Google tells the guest) and frees the slot; cancelling again changes nothing', async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      // Cached now with the event as busy; cancelling must clear that.
      expect(await slotStarts()).toEqual([AT_930]);
      const res = await guest.post(`${manage(manageToken)}/cancel`);
      expect(res.status).toBe(200);
      expect(guestBookingResponseSchema.parse(res.body).booking).toMatchObject({ status: 'CANCELLED', canChange: false });
      expect([...google.events.values()]).toMatchObject([{ deleted: true, sendUpdates: 'all' }]);
      expect(await slotStarts()).toEqual([AT_9, AT_930]);

      const eventCalls = google.calendarRequests.filter((r) => r.url.includes('/events')).length;
      expect((await guest.post(`${manage(manageToken)}/cancel`)).status).toBe(200);
      expect(google.calendarRequests.filter((r) => r.url.includes('/events')).length).toBe(eventCalls);
    });

    it("can't cancel a meeting that has started", async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      clock = Date.parse(AT_9);
      const res = await guest.post(`${manage(manageToken)}/cancel`);
      expect([res.status, res.body.error]).toEqual([409, ALREADY_STARTED]);
    });

    it('changes nothing while Google is down (try again), then works', async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'events' as const })));
      expect((await guest.post(`${manage(manageToken)}/cancel`)).status).toBe(503);
      expect((await db.booking.findFirstOrThrow()).status).toBe('CONFIRMED');
      expect(liveEvents()).toHaveLength(1);
      expect((await guest.post(`${manage(manageToken)}/cancel`)).status).toBe(200);
    });

    describe("when the host's Google access has expired", () => {
      it('still cancels, and shows the host "cancelled, still on your calendar"', async () => {
        await cancelWhileExpired();
        expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: 'CANCELLED', stillOnCalendar: true });
        expect((await hostList()).map((b) => [b.status, b.stillOnCalendar, b.start])).toEqual([['CANCELLED', true, AT_9]]);
        expect(liveEvents()).toHaveLength(1);
      });

      it('removes the event (Google tells the guest) as soon as the host signs in again', async () => {
        await cancelWhileExpired();
        await signInWithGoogle(host, google, HOST);
        expect([...google.events.values()]).toMatchObject([{ deleted: true, sendUpdates: 'all' }]);
        expect((await db.booking.findFirstOrThrow()).stillOnCalendar).toBe(false);
        expect(await hostList()).toEqual([]);
      });

      it('keeps trying: if Google is down when the host reconnects, the next calendar refresh removes it', async () => {
        await cancelWhileExpired();
        google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'events' as const })));
        await signInWithGoogle(host, google, HOST);
        expect((await db.booking.findFirstOrThrow()).stillOnCalendar).toBe(true);
        expect(liveEvents()).toHaveLength(1);

        expect((await host.post('/api/calendars/sync')).status).toBe(200);
        expect((await db.booking.findFirstOrThrow()).stillOnCalendar).toBe(false);
        expect(liveEvents()).toHaveLength(0);
      });

      it('counts an event the host already deleted by hand as removed', async () => {
        await cancelWhileExpired();
        for (const event of google.events.values()) event.deleted = true;
        await signInWithGoogle(host, google, HOST);
        expect((await db.booking.findFirstOrThrow()).stillOnCalendar).toBe(false);
      });
    });
  });

  describe('reschedule', () => {
    it('moves the booking and the same event (Google tells the guest), keeping the link', async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      expect(await slotStarts()).toEqual([AT_930]);
      const res = await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 });
      expect(res.status).toBe(200);
      expect(guestBookingResponseSchema.parse(res.body).booking).toMatchObject({ status: 'CONFIRMED', start: AT_930, end: ist('10:00') });
      expect(liveEvents()).toMatchObject([{ start: AT_930, end: ist('10:00'), sendUpdates: 'all' }]);
      expect(await slotStarts()).toEqual([AT_9]);
      expect((await guest.get(manage(manageToken))).body.booking.start).toBe(AT_930);
    });

    it("doesn't count the booking against itself (daily limit of 1)", async () => {
      await setUpHost({ ...ONE_HOUR, settings: { ...ONE_HOUR.settings, maxPerDay: 1 } });
      const { manageToken } = await booked(AT_9);
      expect((await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 })).status).toBe(200);
    });

    it('refuses a time that is taken or not offered', async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      await booked(AT_930, SAM);
      expect((await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 })).body).toEqual({ error: SLOT_UNAVAILABLE });
      expect((await guest.post(`${manage(manageToken)}/reschedule`, { start: ist('11:00') })).status).toBe(409);
      expect((await db.booking.findFirstOrThrow({ where: { guestEmail: ALEX.guestEmail } })).startsAt.toISOString()).toBe(AT_9);
    });

    it('changes nothing while Google is down, and refuses if the event was deleted from the calendar', async () => {
      await setUpHost();
      const { manageToken } = await booked(AT_9);
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'events' as const })));
      expect((await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 })).status).toBe(503);
      expect((await db.booking.findFirstOrThrow()).startsAt.toISOString()).toBe(AT_9);
      expect(liveEvents()).toMatchObject([{ start: AT_9 }]);

      for (const event of google.events.values()) event.deleted = true;
      const res = await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 });
      expect([res.status, res.body.error]).toEqual([409, CANT_MOVE]);
      expect((await db.booking.findFirstOrThrow()).startsAt.toISOString()).toBe(AT_9);
    });

    it("can't move a cancelled booking or one that has started", async () => {
      await setUpHost();
      const first = await booked(AT_9);
      await guest.post(`${manage(first.manageToken)}/cancel`);
      expect((await guest.post(`${manage(first.manageToken)}/reschedule`, { start: AT_930 })).body).toEqual({ error: BOOKING_CANCELLED });

      const second = await booked(AT_9, SAM);
      clock = Date.parse(AT_9) + 60_000;
      expect((await guest.post(`${manage(second.manageToken)}/reschedule`, { start: AT_930 })).body).toEqual({ error: ALREADY_STARTED });
    });
  });
});

describe('when Google is slow', () => {
  // Shortened limits so the tests run fast: each Google call gets 400 ms (200 ms per attempt, so
  // no retry fits), and a booking waits at most 50 ms for another one of the same host.
  const SHORT: Timeouts = { googleCallMs: 400, connectionWaitMs: 2_000, lockWaitMs: 50, transactionMs: 3_000 };

  beforeEach(() => {
    app = makeApp(SHORT);
    host = new TestBrowser(app);
    guest = new TestBrowser(app);
  });

  it('gives up creating the event in time, books nothing and says so', async () => {
    await setUpHost();
    google.calendarDelays.push({ only: 'events', ms: 5_000 });
    const started = Date.now();
    const res = await book(AT_9);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([res.status, res.body.error]).toEqual([503, "We couldn't add this to Priyanka Rao's calendar, so nothing was booked. Please try again in a few minutes."]);
    expect(await db.booking.count()).toBe(0);
    expect(google.events.size).toBe(0);
    expect(await slotStarts()).toEqual([AT_9, AT_930]);
  });

  it('withdraws an event Google created when its answer came too late, using the id we chose before the call', async () => {
    await setUpHost();
    google.calendarDelays.push({ only: 'events', ms: 5_000, afterApplying: true });
    expect((await book(AT_9)).status).toBe(503);
    expect(await db.booking.count()).toBe(0);

    const insert = google.calendarRequests.find((r) => r.form['method'] === 'POST' && r.url.includes('/events'));
    const sentId = (JSON.parse(insert?.form['body'] ?? '{}') as { id?: string }).id ?? '';
    expect(sentId).toMatch(/^[0-9a-f]{32}$/);
    expect([...google.events.values()]).toMatchObject([{ id: sentId, deleted: true, sendUpdates: 'all' }]);
  });

  it("gives up checking the host's calendar in time, and books nothing", async () => {
    await setUpHost();
    google.calendarDelays.push({ only: 'freeBusy', ms: 5_000 });
    const res = await book(AT_9);
    expect([res.status, res.body.error]).toEqual([503, "We can't check Priyanka Rao's calendar right now, so this time can't be booked. Please try again in a few minutes."]);
    expect(await db.booking.count()).toBe(0);
  });

  it("doesn't wait long for another booking of the same host: the second guest is asked to try again", async () => {
    await setUpHost();
    // The first booking holds the host's lock for 180 ms (a slow but successful Google call).
    google.calendarDelays.push({ only: 'events', ms: 180 });
    lineUp = { size: 2, waiting: [] };
    const results = await Promise.all([book(AT_9, ALEX, guest), book(AT_930, SAM, new TestBrowser(app))]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 503]);
    expect(results.find((r) => r.status === 503)?.body).toEqual({ error: 'Someone else is booking with Priyanka Rao right now. Please try again in a moment.' });
    expect(await db.booking.count()).toBe(1);
  });

  it('keeps a booking whose cancellation timed out, and a retry finishes it', async () => {
    await setUpHost();
    const { manageToken } = await booked(AT_9);
    // Google deletes the event, but the answer comes too late.
    google.calendarDelays.push({ only: 'events', ms: 5_000, afterApplying: true });
    const res = await guest.post(`${manage(manageToken)}/cancel`);
    expect([res.status, res.body.error]).toEqual([
      503,
      "We couldn't confirm the cancellation with Priyanka Rao's calendar, so the booking is still on. Please try again in a few minutes.",
    ]);
    expect((await db.booking.findFirstOrThrow()).status).toBe('CONFIRMED');

    // Deleting again: Google answers "already deleted", which counts as done.
    expect((await guest.post(`${manage(manageToken)}/cancel`)).status).toBe(200);
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: 'CANCELLED', stillOnCalendar: false });
  });

  it('moves the event back when a reschedule timed out after Google had moved it', async () => {
    await setUpHost();
    const { manageToken } = await booked(AT_9);
    google.calendarDelays.push({ only: 'events', ms: 5_000, afterApplying: true });
    expect((await guest.post(`${manage(manageToken)}/reschedule`, { start: AT_930 })).status).toBe(503);
    expect((await db.booking.findFirstOrThrow()).startsAt.toISOString()).toBe(AT_9);
    expect(liveEvents()).toMatchObject([{ start: AT_9, end: AT_930 }]);
  });
});

describe("the host's bookings", () => {
  it('lists upcoming confirmed bookings with guest details, soonest first, a page at a time', async () => {
    await setUpHost();
    await booked(AT_930);
    const cancelled = await booked(AT_9, SAM);
    await guest.post(`/api/public/bookings/${cancelled.manageToken}/cancel`);

    const hostId = (await db.user.findFirstOrThrow({ where: { email: HOST.email } })).id;
    const eventTypeId = (await db.eventType.findFirstOrThrow()).id;
    // A past booking, and enough future ones (one a day from tomorrow) to need a second page.
    await insertBooking(db, { eventTypeId, hostId, start: ist('09:00', '2026-10-05'), end: ist('09:30', '2026-10-05') });
    const dates = Array.from({ length: PAGE_SIZE }, (_, i) => new Date(Date.UTC(2026, 9, 13 + i)).toISOString().slice(0, 10));
    for (const date of dates) await insertBooking(db, { eventTypeId, hostId, start: ist('09:00', date), end: ist('09:30', date) });

    const first = hostBookingsResponseSchema.parse((await host.get('/api/bookings')).body);
    expect(first.bookings).toHaveLength(PAGE_SIZE);
    expect(first.bookings[0]).toMatchObject({ status: 'CONFIRMED', start: AT_930, guestName: 'Alex Kim', guestEmail: 'alex@example.com', eventType: { title: '30-min call' } });
    const second = hostBookingsResponseSchema.parse((await host.get(`/api/bookings?cursor=${first.nextCursor}`)).body);
    expect(second.bookings.map((b) => b.start)).toEqual([ist('09:00', '2026-11-01')]);
    expect(second.nextCursor).toBeNull();

    const other = new TestBrowser(app);
    google.setCalendars(OTHER.sub, [{ id: OTHER.email, summary: OTHER.email, accessRole: 'owner', primary: true }]);
    await signInWithGoogle(other, google, OTHER);
    expect(hostBookingsResponseSchema.parse((await other.get('/api/bookings')).body).bookings).toEqual([]);
    expect((await other.get(`/api/bookings?cursor=${first.nextCursor}`)).status).toBe(400);
  });

  it("lets the host cancel (Google tells the guest), but not another host's booking", async () => {
    await setUpHost();
    await booked(AT_9);
    const [booking] = hostBookingsResponseSchema.parse((await host.get('/api/bookings')).body).bookings;

    const other = new TestBrowser(app);
    google.setCalendars(OTHER.sub, [{ id: OTHER.email, summary: OTHER.email, accessRole: 'owner', primary: true }]);
    await signInWithGoogle(other, google, OTHER);
    expect((await other.post(`/api/bookings/${booking?.id}/cancel`)).status).toBe(404);

    const res = await host.post(`/api/bookings/${booking?.id}/cancel`);
    expect(hostBookingResponseSchema.parse(res.body).booking.status).toBe('CANCELLED');
    expect([...google.events.values()]).toMatchObject([{ deleted: true, sendUpdates: 'all' }]);
  });

  it('requires signing in', async () => {
    expect((await guest.get('/api/bookings')).status).toBe(401);
  });
});
