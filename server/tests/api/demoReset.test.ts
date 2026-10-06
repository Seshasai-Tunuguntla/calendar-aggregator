import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { localParts } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { DEMO_HOST, DEMO_IDS, DEMO_TIME_ZONE } from '../../src/demo/demoData.ts';
import { DEMO_RESET_INTERVAL_MS, ensureDemoExists, resetDemoIfStale } from '../../src/demo/resetDemo.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG } from '../helpers/fakeGoogle.ts';
import { fromOurPage } from '../helpers/http.ts';

const db = useTestDatabase();

// Monday 12 October 2026, 08:30 in India.
const NOW = new Date('2026-10-12T03:00:00Z');
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

// Everything about the demo a visitor could change, without generated ids and timestamps.
async function demoSnapshot() {
  const host = await db.user.findUniqueOrThrow({
    where: { id: DEMO_IDS.host },
    select: {
      name: true, email: true, handle: true, timeZone: true, isDemo: true, bookingCalendarId: true,
      bufferBeforeMinutes: true, bufferAfterMinutes: true, minNoticeMinutes: true, horizonDays: true, maxPerDay: true,
    },
  });
  const [connections, calendars, rules, eventTypes, busyEvents, bookings, busyCache] = await Promise.all([
    db.calendarConnection.findMany({ where: { userId: DEMO_IDS.host }, select: { id: true, provider: true, externalAccountId: true, accountEmail: true, status: true }, orderBy: { id: 'asc' } }),
    db.calendar.findMany({
      where: { connection: { userId: DEMO_IDS.host } },
      select: { id: true, connectionId: true, externalCalendarId: true, name: true, isPrimary: true, countsAsBusy: true, canCreateEvents: true, busyAccess: true },
      orderBy: { id: 'asc' },
    }),
    db.availabilityRule.findMany({ where: { userId: DEMO_IDS.host }, select: { weekday: true, startMinute: true, endMinute: true }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
    db.eventType.findMany({
      where: { userId: DEMO_IDS.host },
      select: { id: true, slug: true, title: true, description: true, durationMinutes: true, slotStepMinutes: true, active: true },
      orderBy: { id: 'asc' },
    }),
    db.demoBusyEvent.findMany({ select: { calendarId: true, startsAt: true, endsAt: true }, orderBy: [{ startsAt: 'asc' }, { calendarId: 'asc' }] }),
    db.booking.count({ where: { hostId: DEMO_IDS.host } }),
    db.busyCache.count({ where: { hostId: DEMO_IDS.host } }),
  ]);
  return { host, connections, calendars, rules, eventTypes, busyEvents, bookings, busyCache };
}

function demoApp(clock: { now: Date }, options: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ db, production: false, rateLimits: false, now: () => clock.now, ...options });
}

async function signInAsDemo(app: ReturnType<typeof createApp>) {
  const visitor = new TestBrowser(app);
  expect((await visitor.post('/api/auth/demo')).status).toBe(200);
  return visitor;
}

// A guest books the first free time of an event type on a given day (Priya's dates).
async function guestBooks(app: ReturnType<typeof createApp>, slug: string, date: string, index = 0) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const slots = await request(app).get(`/api/public/book/priya/${slug}/slots?from=${date}&to=${next.toISOString().slice(0, 10)}&tz=${DEMO_TIME_ZONE}`);
  const start = slots.body.slots[index].start as string;
  const res = await fromOurPage(request(app).post(`/api/public/book/priya/${slug}/bookings`)).send({
    start, guestName: 'Visitor Guest', guestEmail: 'guest@example.com', guestTimeZone: 'Europe/London',
  });
  expect(res.status).toBe(201);
  return res.body as { manageToken: string; booking: { start: string } };
}

// A visitor changes everything the demo lets them change.
async function changeEverything(app: ReturnType<typeof createApp>, visitor: TestBrowser) {
  const booked = await guestBooks(app, '60-min-session', '2026-10-13');
  await guestBooks(app, '60-min-session', '2026-10-14');
  const bookings = (await visitor.get('/api/bookings')).body.bookings as { id: string }[];
  expect((await visitor.post(`/api/bookings/${bookings[0]?.id}/cancel`)).status).toBe(200);

  expect(
    (
      await visitor.put('/api/availability', {
        timeZone: 'Europe/Berlin',
        rules: [{ weekday: 7, startMinute: 0, endMinute: 60 }],
        settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 5, maxPerDay: 1 },
      })
    ).status,
  ).toBe(200);
  expect((await visitor.patch(`/api/calendars/${DEMO_IDS.calendars.personal}`, { countsAsBusy: false })).status).toBe(200);
  expect((await visitor.put('/api/calendars/booking-calendar', { calendarId: DEMO_IDS.calendars.personal })).status).toBe(200);
  expect((await visitor.post('/api/event-types', { slug: 'visitors-call', title: "A visitor's call", durationMinutes: 45, slotStepMinutes: 15 })).status).toBe(201);
  expect((await visitor.patch(`/api/event-types/${DEMO_IDS.eventTypes.call}`, { title: 'Renamed', slug: 'renamed', active: false })).status).toBe(200);
  expect((await visitor.delete(`/api/event-types/${DEMO_IDS.eventTypes.chat}`)).status).toBe(204);
  // The busy cache gets filled by a guest looking at times.
  await request(app).get(`/api/public/book/priya/60-min-session/slots?from=2026-10-15&to=2026-10-16&tz=UTC`);
  return { manageToken: booked.manageToken };
}

describe('the self-resetting demo', () => {
  it('restores everything a visitor changed, on the first demo login 30 minutes after the last reset', async () => {
    const clock = { now: NOW };
    const app = demoApp(clock);
    const visitor = await signInAsDemo(app);
    const fresh = await demoSnapshot();
    const { manageToken } = await changeEverything(app, visitor);
    const changed = await demoSnapshot();
    for (const part of ['host', 'calendars', 'rules', 'eventTypes', 'busyEvents', 'bookings', 'busyCache'] as const) {
      expect(changed[part], part).not.toEqual(fresh[part]);
    }

    // 29 minutes on: too soon, nothing is reset.
    clock.now = at(DEMO_RESET_INTERVAL_MS - MINUTE);
    await signInAsDemo(app);
    expect(await demoSnapshot()).toEqual(changed);

    // 30 minutes on: the next demo login rebuilds it exactly as it was.
    clock.now = at(DEMO_RESET_INTERVAL_MS);
    await signInAsDemo(app);
    expect(await demoSnapshot()).toEqual(fresh);
    expect(await db.demoState.findUniqueOrThrow({ where: { id: 1 } })).toEqual({ id: 1, lastResetAt: clock.now });

    // The visitor who was signed in stays signed in, and sees the fresh demo.
    expect((await visitor.get('/api/auth/me')).status).toBe(200);
    expect((await visitor.get('/api/event-types')).body.eventTypes.map((e: { slug: string }) => e.slug)).toEqual(['15-min-chat', '30-min-call', '60-min-session']);
    // A guest's manage link from before the reset no longer finds a booking.
    expect((await request(app).get(`/api/public/bookings/${manageToken}`)).status).toBe(404);
  });

  it('keeps the same ids across resets, so every link still works', async () => {
    const clock = { now: NOW };
    const app = demoApp(clock);
    await signInAsDemo(app);
    clock.now = at(DEMO_RESET_INTERVAL_MS);
    await signInAsDemo(app);
    const after = await demoSnapshot();
    expect(after.connections.map((c) => c.id)).toEqual([DEMO_IDS.connection]);
    expect(after.calendars.map((c) => c.id).toSorted()).toEqual(Object.values(DEMO_IDS.calendars).toSorted());
    expect(after.eventTypes.map((e) => e.id).toSorted()).toEqual(Object.values(DEMO_IDS.eventTypes).toSorted());
    expect((await request(app).get('/api/public/book/priya/30-min-call')).status).toBe(200);
  });

  it('regenerates the busy events around the new "today", from the day before through the booking horizon', async () => {
    const clock = { now: NOW };
    const app = demoApp(clock);
    await signInAsDemo(app);
    // Four days later (Friday 16 October), the next login rebuilds the week around that day.
    clock.now = at(4 * 24 * 60 * MINUTE);
    await signInAsDemo(app);
    const dates = (await demoSnapshot()).busyEvents.map((e) => localParts(e.startsAt.getTime(), DEMO_TIME_ZONE).date);
    expect(dates[0]).toBe('2026-10-15');
    // The horizon is 30 days; events go one day further, for guests in zones ahead of Priya's.
    expect(dates.at(-1)).toBe('2026-11-16');
    expect(DEMO_HOST.horizonDays).toBe(30);
  });

  it('runs one rebuild at a time: of two that find it due together, only one rebuilds', async () => {
    await resetDemoIfStale(db, NOW);
    const later = at(DEMO_RESET_INTERVAL_MS);
    const results = await Promise.all([resetDemoIfStale(db, later), resetDemoIfStale(db, later)]);
    expect(results.toSorted()).toEqual([false, true]);
    expect(await db.calendar.count()).toBe(3);
    expect(await db.eventType.count()).toBe(3);
  });

  it("waits for a booking change in progress (the host's booking lock) before rebuilding", async () => {
    await resetDemoIfStale(db, NOW);
    let release!: () => void;
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DEMO_IDS.host}, 0))`;
        locked();
        await new Promise<void>((resolve) => (release = resolve));
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    let finished = false;
    const reset = resetDemoIfStale(db, at(DEMO_RESET_INTERVAL_MS)).then((rebuilt) => {
      finished = true;
      return rebuilt;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    release();
    await holder;
    expect(await reset).toBe(true);
  });

  it('builds the demo for "Try booking" when it has never been built, but never resets one that exists', async () => {
    expect(await ensureDemoExists(db, NOW)).toBe(true);
    await db.eventType.update({ where: { id: DEMO_IDS.eventTypes.chat }, data: { title: 'Changed' } });
    expect(await ensureDemoExists(db, at(10 * DEMO_RESET_INTERVAL_MS))).toBe(false);
    expect((await db.eventType.findUniqueOrThrow({ where: { id: DEMO_IDS.eventTypes.chat } })).title).toBe('Changed');
  });

  it('builds it again if the demo host has gone, whatever the reset time says', async () => {
    await resetDemoIfStale(db, NOW);
    await db.user.delete({ where: { id: DEMO_IDS.host } });
    expect(await resetDemoIfStale(db, at(MINUTE))).toBe(true);
    expect(await db.eventType.count()).toBe(3);
  });

  describe('on a cold start', () => {
    it('rebuilds a stale demo before answering the first request, once per server instance', async () => {
      await resetDemoIfStale(db, NOW);
      await db.eventType.update({ where: { id: DEMO_IDS.eventTypes.call }, data: { active: false } });
      const clock = { now: at(DEMO_RESET_INTERVAL_MS) };
      const app = demoApp(clock, { resetDemoOnColdStart: true });

      // The first request of a new instance finds the 30-minute-old demo and rebuilds it first.
      expect((await request(app).get('/api/public/book/priya/30-min-call')).status).toBe(200);
      expect((await db.demoState.findUniqueOrThrow({ where: { id: 1 } })).lastResetAt).toEqual(clock.now);

      // Only the first request of the instance checks: later ones don't, however old it gets.
      await db.eventType.update({ where: { id: DEMO_IDS.eventTypes.call }, data: { active: false } });
      clock.now = at(3 * DEMO_RESET_INTERVAL_MS);
      expect((await request(app).get('/api/public/book/priya/30-min-call')).status).toBe(404);

      // A new instance (the next cold start) checks again.
      expect((await request(demoApp(clock, { resetDemoOnColdStart: true })).get('/api/public/book/priya/30-min-call')).status).toBe(200);
    });

    it("leaves a demo that isn't 30 minutes old alone", async () => {
      await resetDemoIfStale(db, NOW);
      await db.eventType.update({ where: { id: DEMO_IDS.eventTypes.call }, data: { active: false } });
      const app = demoApp({ now: at(DEMO_RESET_INTERVAL_MS - MINUTE) }, { resetDemoOnColdStart: true });
      expect((await request(app).get('/api/public/book/priya/30-min-call')).status).toBe(404);
    });

    it("doesn't happen unless the app asks for it (tests, and anything else that builds the app)", async () => {
      await resetDemoIfStale(db, NOW);
      await db.eventType.update({ where: { id: DEMO_IDS.eventTypes.call }, data: { active: false } });
      const app = demoApp({ now: at(10 * DEMO_RESET_INTERVAL_MS) });
      expect((await request(app).get('/api/public/book/priya/30-min-call')).status).toBe(404);
    });
  });

  it('never contacts Google for demo bookings: booking, moving and cancelling stay in the database', async () => {
    const google = await FakeGoogle.create();
    const clock = { now: NOW };
    const app = demoApp(clock, { google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
    const visitor = await signInAsDemo(app);
    const first = await guestBooks(app, '30-min-call', '2026-10-13');
    await guestBooks(app, '30-min-call', '2026-10-14');

    const slots = await request(app).get(`/api/public/book/priya/30-min-call/slots?from=2026-10-15&to=2026-10-16&tz=${DEMO_TIME_ZONE}`);
    const moved = await fromOurPage(request(app).post(`/api/public/bookings/${first.manageToken}/reschedule`)).send({ start: slots.body.slots[0].start });
    expect(moved.status).toBe(200);
    expect((await fromOurPage(request(app).post(`/api/public/bookings/${first.manageToken}/cancel`))).status).toBe(200);
    const [other] = (await visitor.get('/api/bookings')).body.bookings as { id: string }[];
    expect((await visitor.post(`/api/bookings/${other?.id}/cancel`)).status).toBe(200);

    expect(google.requests).toEqual([]);
    // The bookings' events were added to and removed from the demo calendar instead.
    expect(await db.booking.count({ where: { status: 'CANCELLED' } })).toBe(2);
  });
});
