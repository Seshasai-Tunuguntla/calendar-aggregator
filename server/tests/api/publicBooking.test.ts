import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarsResponseSchema, publicEventTypeResponseSchema, slotsResponseSchema, type Availability } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { BUSY_CACHE_TTL_MS } from '../../src/calendar/busyCache.ts';
import { SLOTS_UNAVAILABLE } from '../../src/routes/publicBooking.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking } from '../helpers/factories.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount, type FakeCalendar } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';

const db = useTestDatabase();

// Monday 12 October 2026, 08:00 in India (02:30 UTC): the worked example in docs/PLAN.md.
const NOW = new Date('2026-10-12T02:30:00Z');
const HOST: FakeAccount = { sub: '8000000000000000001', email: 'priyanka@gmail.com', name: 'Priyanka Rao' };
const WORK: FakeAccount = { sub: '8000000000000000002', email: 'priyanka@work.example', name: 'Priyanka (Work)' };
const HOLIDAY_ID = 'en.indian#holiday@group.v.calendar.google.com';
const PAGE = '/api/public/book/priyanka-rao/30-min-call';

// IST is UTC+5:30 all year.
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).toISOString();
const busy = (date: string, from: string, to: string) => ({ start: ist(date, from), end: ist(date, to) });

const WORKED_EXAMPLE: Availability = {
  timeZone: 'Asia/Kolkata',
  rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 }],
  settings: { bufferBeforeMinutes: 15, bufferAfterMinutes: 15, minNoticeMinutes: 240, horizonDays: 30, maxPerDay: null },
};
// Monday 09:00-10:00 only, no buffers or notice: two 30-minute slots, at 09:00 and 09:30 IST.
const ONE_HOUR: Availability = {
  timeZone: 'Asia/Kolkata',
  rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }],
  settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 30, maxPerDay: null },
};

let google: FakeGoogle;
let clock: number;
let app: ReturnType<typeof createApp>;
let host: TestBrowser;
let guest: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  clock = NOW.getTime();
  app = createApp({ db, production: false, rateLimits: false, now: () => new Date(clock), google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep: async () => {} } });
  host = new TestBrowser(app);
  guest = new TestBrowser(app);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setUpHost(availability: Availability, calendars: FakeCalendar[]) {
  google.setCalendars(HOST.sub, calendars);
  await signInWithGoogle(host, google, HOST);
  expect((await host.put('/api/availability', availability)).status).toBe(200);
  expect((await host.post('/api/event-types', { slug: '30-min-call', title: '30-min call', description: 'Talk it through.', durationMinutes: 30, slotStepMinutes: 30 })).status).toBe(201);
}

const primary = (busyTimes: { start: string; end: string }[] = []): FakeCalendar => ({
  id: HOST.email,
  summary: HOST.email,
  accessRole: 'owner',
  primary: true,
  busy: busyTimes,
});

async function slotStarts(query: string) {
  const res = await guest.get(`${PAGE}/slots?${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return slotsResponseSchema.parse(res.body).slots.map((s) => s.start);
}

const MONDAY_IN_INDIA = 'from=2026-10-12&to=2026-10-13&tz=Asia/Kolkata';

const mondaySlots = async () => {
  const res = await guest.get(`${PAGE}/slots?${MONDAY_IN_INDIA}`);
  return { status: res.status, body: res.body as unknown };
};
const UNAVAILABLE = { status: 503, body: { error: SLOTS_UNAVAILABLE } };
const freeBusyCalls = () => google.calendarRequests.filter((r) => r.url.endsWith('/freeBusy')).length;

describe('GET /api/public/book/:handle/:slug', () => {
  it('shows the host and event type, and nothing private', async () => {
    await setUpHost(ONE_HOUR, [primary(), { id: 'team@group.calendar.google.com', summary: 'Secret team', accessRole: 'writer' }]);
    const res = await guest.get(PAGE);
    expect(res.status).toBe(200);
    expect(publicEventTypeResponseSchema.parse(res.body)).toEqual({
      host: { name: 'Priyanka Rao', timeZone: 'Asia/Kolkata', isDemo: false },
      eventType: { slug: '30-min-call', title: '30-min call', description: 'Talk it through.', durationMinutes: 30 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/priyanka@|Secret team|buffer|maxPerDay/);
  });

  it('is a 404 for an unknown host or event type, or one that is turned off', async () => {
    await setUpHost(ONE_HOUR, [primary()]);
    expect((await guest.get('/api/public/book/nobody/30-min-call')).status).toBe(404);
    expect((await guest.get('/api/public/book/priyanka-rao/nothing')).status).toBe(404);
    const [eventType] = (await host.get('/api/event-types')).body.eventTypes as { id: string }[];
    await host.patch(`/api/event-types/${eventType?.id}`, { active: false });
    expect((await guest.get(PAGE)).status).toBe(404);
    expect((await guest.get(`${PAGE}/slots?${MONDAY_IN_INDIA}`)).status).toBe(404);
  });
});

describe('GET /api/public/book/:handle/:slug/slots', () => {
  it('reproduces the worked example end to end: only 12:30-13:00 IST is offered', async () => {
    await setUpHost(WORKED_EXAMPLE, [primary([busy('2026-10-12', '09:30', '10:00'), busy('2026-10-12', '09:45', '10:30'), busy('2026-10-12', '11:30', '12:00')])]);
    const res = await guest.get(`${PAGE}/slots?${MONDAY_IN_INDIA}`);
    expect(slotsResponseSchema.parse(res.body).slots).toEqual([{ start: ist('2026-10-12', '12:30'), end: ist('2026-10-12', '13:00') }]);
  });

  it("uses the guest's days: 09:00 IST Monday is late Sunday evening in New York", async () => {
    await setUpHost(ONE_HOUR, [primary()]);
    expect(await slotStarts('from=2026-10-11&to=2026-10-12&tz=America/New_York')).toEqual([ist('2026-10-12', '09:00')]);
    expect(await slotStarts('from=2026-10-12&to=2026-10-13&tz=America/New_York')).toEqual([ist('2026-10-12', '09:30')]);
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:00'), ist('2026-10-12', '09:30')]);
  });

  it('blocks time only on calendars that count as busy', async () => {
    await setUpHost(ONE_HOUR, [primary(), { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', busy: [busy('2026-10-12', '09:00', '09:30')] }]);
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:00'), ist('2026-10-12', '09:30')]);

    const team = calendarsResponseSchema.parse((await host.get('/api/calendars')).body).calendars.find((c) => c.name === 'Team');
    expect((await host.patch(`/api/calendars/${team?.id}`, { countsAsBusy: true })).status).toBe(200);
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:30')]);
  });

  it("combines busy time from all the host's Google accounts", async () => {
    google.setCalendars(WORK.sub, [{ id: WORK.email, summary: WORK.email, accessRole: 'owner', primary: true, busy: [busy('2026-10-12', '09:30', '10:00')] }]);
    await setUpHost(ONE_HOUR, [primary([busy('2026-10-12', '09:00', '09:30')])]);
    await signInWithGoogle(host, google, WORK, { intent: 'connect' });
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([]);

    // Disconnecting the work account clears the cached busy time at once.
    const work = (await host.get('/api/connections')).body.connections.find((c: { accountEmail: string }) => c.accountEmail === WORK.email);
    expect((await host.delete(`/api/connections/${work.id}`)).status).toBe(200);
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:30')]);
  });

  it("blocks the host's confirmed bookings (not cancelled ones) and respects the daily limit", async () => {
    await setUpHost({ ...ONE_HOUR, settings: { ...ONE_HOUR.settings, maxPerDay: 2 } }, [primary()]);
    const hostId = (await db.user.findFirstOrThrow({ where: { email: HOST.email } })).id;
    const eventTypeId = (await db.eventType.findFirstOrThrow({ where: { userId: hostId } })).id;
    const book = (from: string, to: string, status: 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED') =>
      createBooking(db, { eventTypeId, hostId, start: ist('2026-10-12', from), end: ist('2026-10-12', to), status });

    await book('09:00', '09:30', 'CANCELLED');
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:00'), ist('2026-10-12', '09:30')]);
    await book('09:00', '09:30');
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:30')]);
    // A second booking that day, outside working hours, reaches the limit of 2.
    await book('15:00', '15:30');
    expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([]);
  });

  it('never asks Google beyond the booking horizon, even for a 42-day request', async () => {
    await setUpHost(ONE_HOUR, [primary()]);
    google.requests.length = 0;
    await slotStarts('from=2026-10-12&to=2026-11-23&tz=Asia/Kolkata');
    const [request] = google.calendarRequests.map((r) => JSON.parse(r.form['body'] ?? '{}') as { timeMin: string; timeMax: string });
    // From now (no notice) to the 30-day horizon, plus the 30-minute event and the cache's hour.
    expect(request).toMatchObject({ timeMin: NOW.toISOString(), timeMax: new Date(NOW.getTime() + 30 * 24 * 3_600_000 + 90 * 60_000).toISOString() });
    expect(google.calendarRequests).toHaveLength(1);
  });

  it('asks Google nothing for days outside minimum notice and the booking horizon', async () => {
    await setUpHost(ONE_HOUR, [primary()]);
    google.requests.length = 0;
    expect(await slotStarts('from=2027-01-04&to=2027-01-11&tz=Asia/Kolkata')).toEqual([]);
    expect(await slotStarts('from=2026-10-01&to=2026-10-08&tz=Asia/Kolkata')).toEqual([]);
    expect(google.calendarRequests).toHaveLength(0);
  });

  describe('the 60-second busy-time cache', () => {
    it('lets many guests on the same page cause one read of the calendars', async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      google.requests.length = 0;
      for (let i = 0; i < 5; i++) await slotStarts(MONDAY_IN_INDIA);
      await Promise.all(Array.from({ length: 5 }, () => slotStarts(MONDAY_IN_INDIA)));
      clock += 30_000;
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
      expect(freeBusyCalls()).toBe(1);
    });

    it('shares one read between guests who arrive at the same moment', async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      google.requests.length = 0;
      await Promise.all(Array.from({ length: 5 }, () => slotStarts(MONDAY_IN_INDIA)));
      expect(freeBusyCalls()).toBe(1);
    });

    it('shows a change made on Google after 60 seconds', async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
      google.setCalendars(HOST.sub, [primary([busy('2026-10-12', '09:00', '09:30')])]);
      clock += BUSY_CACHE_TTL_MS - 1;
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
      clock += 1;
      expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:30')]);
    });

    it('is cleared when the host changes which calendars count', async () => {
      await setUpHost(ONE_HOUR, [primary(), { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', busy: [busy('2026-10-12', '09:00', '09:30')] }]);
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
      const team = calendarsResponseSchema.parse((await host.get('/api/calendars')).body).calendars.find((c) => c.name === 'Team');
      await host.patch(`/api/calendars/${team?.id}`, { countsAsBusy: true });
      expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([ist('2026-10-12', '09:30')]);
      await host.patch(`/api/calendars/${team?.id}`, { countsAsBusy: false });
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
    });

    it('is cleared when the host refreshes their calendars', async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
      google.setCalendars(HOST.sub, [primary([busy('2026-10-12', '09:00', '10:00')])]);
      await host.post('/api/calendars/sync');
      expect(await slotStarts(MONDAY_IN_INDIA)).toEqual([]);
    });

    it("doesn't keep a failure: the next guest gets slots as soon as Google is back", async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError' })));
      expect(await mondaySlots()).toEqual(UNAVAILABLE);
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
    });
  });

  describe('fails closed: no slots when busy time is unknown, and nothing private in the error', () => {
    it("when a calendar that counts as busy can't be read", async () => {
      await setUpHost(ONE_HOUR, [primary(), { id: HOLIDAY_ID, summary: 'Holidays in India', accessRole: 'reader', freeBusyError: 'notFound' }]);
      // The API refuses to tick it; a calendar shared earlier and later made unreadable gets here.
      await db.calendar.updateMany({ where: { externalCalendarId: HOLIDAY_ID }, data: { countsAsBusy: true } });
      expect(await mondaySlots()).toEqual(UNAVAILABLE);
    });

    it('when Google is down or rate limiting', async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError' })));
      expect(await mondaySlots()).toEqual(UNAVAILABLE);
      google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 429, reason: 'rateLimitExceeded' })));
      expect(await mondaySlots()).toEqual(UNAVAILABLE);
      expect(await slotStarts(MONDAY_IN_INDIA)).toHaveLength(2);
    });

    it("when the host's Google access was revoked", async () => {
      await setUpHost(ONE_HOUR, [primary()]);
      google.revokeAccessTokens();
      google.revokeAll(HOST.sub);
      expect(await mondaySlots()).toEqual(UNAVAILABLE);
    });
  });

  it.each([
    ['a fixed offset', 'from=2026-10-12&to=2026-10-13&tz=%2B05:30', 'Unknown time zone'],
    ['"to" not after "from"', 'from=2026-10-12&to=2026-10-12&tz=Asia/Kolkata', '"to" must be after "from"'],
    ['more than 42 days', 'from=2026-10-12&to=2026-11-24&tz=Asia/Kolkata', 'At most 42 days at a time'],
  ])('rejects %s (400) with a clear message', async (_name, query, message) => {
    await setUpHost(ONE_HOUR, [primary()]);
    const res = await guest.get(`${PAGE}/slots?${query}`);
    expect([res.status, res.body.error]).toEqual([400, message]);
  });

  it('rejects a missing time zone or a malformed date (400)', async () => {
    await setUpHost(ONE_HOUR, [primary()]);
    expect((await guest.get(`${PAGE}/slots?from=2026-10-12&to=2026-10-13`)).status).toBe(400);
    expect((await guest.get(`${PAGE}/slots?from=12-10-2026&to=2026-10-13&tz=Asia/Kolkata`)).status).toBe(400);
  });

  it('opens the demo booking page ("Try booking") even before anyone has used "Try as host"', async () => {
    expect(await db.user.count({ where: { isDemo: true } })).toBe(0);
    const res = await guest.get('/api/public/book/priya/30-min-call');
    expect(res.status).toBe(200);
    expect(publicEventTypeResponseSchema.parse(res.body).host).toEqual({ name: 'Priya Sharma', timeZone: 'Asia/Kolkata', isDemo: true });
    expect((await guest.get('/api/public/book/priya/30-min-call/slots?from=2026-10-13&to=2026-10-14&tz=Asia/Kolkata')).status).toBe(200);
  });

  it("works for the demo host, whose busy times come from the demo provider", async () => {
    await new TestBrowser(app).post('/api/auth/demo');
    const res = await guest.get('/api/public/book/priya/30-min-call/slots?from=2026-10-12&to=2026-10-19&tz=Asia/Kolkata');
    const slots = slotsResponseSchema.parse(res.body).slots.map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) }));
    expect(slots.length).toBeGreaterThan(10);

    const busyTimes = await db.demoBusyEvent.findMany({ where: { calendar: { countsAsBusy: true } } });
    for (const slot of slots) {
      expect(busyTimes.some((b) => b.startsAt.getTime() < slot.end && b.endsAt.getTime() > slot.start)).toBe(false);
    }
  });
});
