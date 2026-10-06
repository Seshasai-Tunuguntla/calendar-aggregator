import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { deleteAccountResponseSchema, eventTypeResponseSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { createBooking } from '../helpers/factories.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';
import { TEST_HOST } from '../helpers/http.ts';

const db = useTestDatabase();

const NOW = new Date('2026-10-12T02:30:00Z');
const HOST: FakeAccount = { sub: '9000000000000000001', email: 'priyanka@gmail.com', name: 'Priyanka Rao' };
const WORK: FakeAccount = { sub: '9000000000000000002', email: 'priyanka@work.example', name: 'Priyanka (Work)' };
const OTHER: FakeAccount = { sub: '9000000000000000003', email: 'other@gmail.com', name: 'Other Host' };
const CONFIRM = { confirmHandle: 'priyanka-rao' };

let google: FakeGoogle;
let app: ReturnType<typeof createApp>;
let browser: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  for (const account of [HOST, WORK, OTHER]) {
    google.setCalendars(account.sub, [{ id: account.email, summary: account.email, accessRole: 'owner', primary: true }]);
  }
  app = createApp({ db, production: false, rateLimits: false, now: () => NOW, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep: async () => {} } });
  browser = new TestBrowser(app);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A host with everything a host can have: a second Google account, hours, an event type, and
// bookings (upcoming with a Google event on each account, one past). Returns the guests' event ids.
async function setUpHost(b: TestBrowser, account: FakeAccount, second?: FakeAccount) {
  await signInWithGoogle(b, google, account);
  if (second) await signInWithGoogle(b, google, second, { intent: 'connect' });
  await b.put('/api/availability', {
    timeZone: 'Asia/Kolkata',
    rules: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
    settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 30, maxPerDay: null },
  });
  const { eventType } = eventTypeResponseSchema.parse((await b.post('/api/event-types', { slug: 'call', title: 'Call', durationMinutes: 30, slotStepMinutes: 30 })).body);
  const user = await db.user.findFirstOrThrow({ where: { email: account.email } });
  const calendars = await db.calendar.findMany({ where: { connection: { userId: user.id } }, orderBy: { name: 'asc' } });

  const events: string[] = [];
  const bookWithEvent = async (start: string, end: string, calendarIndex: number) => {
    const calendar = calendars[calendarIndex];
    if (!calendar) throw new Error('No such calendar');
    const eventId = `evt${events.length}${user.id.replaceAll('-', '').slice(-8)}`;
    google.events.set(eventId, { id: eventId, calendarId: calendar.externalCalendarId, summary: 'Call', start, end, attendees: [], sendUpdates: null, deleted: false });
    const booking = await createBooking(db, { eventTypeId: eventType.id, hostId: user.id, start, end });
    await db.booking.update({ where: { id: booking.id }, data: { externalEventId: eventId, calendarId: calendar.id } });
    events.push(eventId);
  };
  await bookWithEvent('2026-10-05T04:00:00Z', '2026-10-05T04:30:00Z', 0); // past
  await bookWithEvent('2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 0); // upcoming
  if (second) await bookWithEvent('2026-10-26T04:00:00Z', '2026-10-26T04:30:00Z', 1); // upcoming, second account
  return { userId: user.id, events };
}

// Rows per table: for checking that everything of one user is gone and nobody else's changed.
async function rowCounts(database: Db) {
  return {
    users: await database.user.count(),
    sessions: await database.session.count(),
    connections: await database.calendarConnection.count(),
    calendars: await database.calendar.count(),
    rules: await database.availabilityRule.count(),
    eventTypes: await database.eventType.count(),
    bookings: await database.booking.count(),
  };
}

describe('DELETE /api/account', () => {
  it("deletes all of the user's data and nobody else's, revokes Google access, cancels upcoming events and ends every session", async () => {
    const other = new TestBrowser(app);
    await setUpHost(other, OTHER);
    const othersOnly = await rowCounts(db);
    const { userId, events } = await setUpHost(browser, HOST, WORK);
    const secondDevice = new TestBrowser(app);
    await signInWithGoogle(secondDevice, google, HOST);
    const tokensBefore = google.refreshTokensIssued;

    const res = await browser.delete('/api/account', CONFIRM);
    expect(res.status).toBe(200);
    expect(deleteAccountResponseSchema.parse(res.body)).toEqual({ revokedAtGoogle: true, eventsNotDeleted: 0 });

    // Every table is back to just the other host's rows.
    expect(await rowCounts(db)).toEqual(othersOnly);
    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();

    // Both of the user's Google accounts are revoked; the other host's isn't.
    const issuedFor = (index: number) => tokensBefore[index] ?? '';
    expect([issuedFor(1), issuedFor(2)].map((t) => google.isRevoked(t))).toEqual([true, true]);
    expect(google.isRevoked(issuedFor(0))).toBe(false);

    // Upcoming events are deleted, and Google is asked to tell the guests; the past one is left.
    const [past, upcoming, upcomingOnWork] = events.map((id) => google.events.get(id));
    expect([upcoming, upcomingOnWork].map((e) => [e?.deleted, e?.sendUpdates])).toEqual([[true, 'all'], [true, 'all']]);
    expect(past?.deleted).toBe(false);

    // Signed out everywhere; the other host isn't.
    expect(browser.cookies.size).toBe(0);
    expect((await secondDevice.get('/api/auth/me')).status).toBe(401);
    expect((await other.get('/api/auth/me')).status).toBe(200);
  });

  it('changes nothing unless the user types their own handle', async () => {
    await setUpHost(browser, HOST);
    const before = await rowCounts(db);
    for (const body of [{ confirmHandle: 'someone-else' }, { confirmHandle: 'PRIYANKA-RAO' }, {}]) {
      expect((await browser.delete('/api/account', body)).status).toBe(400);
    }
    expect((await browser.delete('/api/account', { confirmHandle: 'nope' })).body).toEqual({ error: 'Type your handle, priyanka-rao, to confirm' });
    expect(await rowCounts(db)).toEqual(before);
    expect((await browser.get('/api/auth/me')).status).toBe(200);
  });

  it("refuses the demo host (403): visitors share it", async () => {
    await browser.post('/api/auth/demo');
    const res = await browser.delete('/api/account', { confirmHandle: 'priya' });
    expect(res.status).toBe(403);
    expect(await db.user.count({ where: { isDemo: true } })).toBe(1);
  });

  it('still deletes everything when Google is unreachable, and says what it could not do', async () => {
    const { events } = await setUpHost(browser, HOST);
    google.failNext = 'network';
    google.calendarFailures.push('network', 'network', 'network');

    const res = await browser.delete('/api/account', CONFIRM);
    expect(res.status).toBe(200);
    expect(deleteAccountResponseSchema.parse(res.body)).toEqual({ revokedAtGoogle: false, eventsNotDeleted: 1 });
    expect(await rowCounts(db)).toEqual({ users: 0, sessions: 0, connections: 0, calendars: 0, rules: 0, eventTypes: 0, bookings: 0 });
    expect(google.events.get(events[1] ?? '')?.deleted).toBe(false);
  });

  it('reports revokedAtGoogle: false when only one of two Google accounts could be revoked', async () => {
    await setUpHost(browser, HOST, WORK);
    google.failNext = 'network';
    const res = await browser.delete('/api/account', CONFIRM);
    expect(deleteAccountResponseSchema.parse(res.body).revokedAtGoogle).toBe(false);
    expect(google.refreshTokensIssued.map((t) => google.isRevoked(t)).toSorted()).toEqual([false, true]);
    expect(await db.user.count()).toBe(0);
  });

  it("doesn't tell a user with no Google account to remove access at Google", async () => {
    const user = await db.user.create({ data: { name: 'No Google', email: 'none@example.com', handle: 'no-google', timeZone: 'UTC' } });
    const token = 'local-test-session-token-for-no-google-user-01';
    await db.session.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(NOW.getTime() + 60_000) } });
    browser.cookies.set('session', token);
    const res = await browser.delete('/api/account', { confirmHandle: 'no-google' });
    expect(deleteAccountResponseSchema.parse(res.body)).toEqual({ revokedAtGoogle: true, eventsNotDeleted: 0 });
  });

  it('needs the Origin header (CSRF) and a signed-in user', async () => {
    await setUpHost(browser, HOST);
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const noOrigin = await request(app).delete('/api/account').set('Host', TEST_HOST).set('Cookie', cookie).send(CONFIRM);
    expect(noOrigin.status).toBe(403);
    expect((await new TestBrowser(app).delete('/api/account', CONFIRM)).status).toBe(401);
    expect(await db.user.count()).toBe(1);
  });

  it('lets the same Google account sign up again afterwards, as a fresh, empty user', async () => {
    const { userId } = await setUpHost(browser, HOST);
    await browser.delete('/api/account', CONFIRM);

    await signInWithGoogle(browser, google, HOST);
    const user = await db.user.findFirstOrThrow({ where: { email: HOST.email } });
    expect(user.id).not.toBe(userId);
    expect(user.handle).toBe('priyanka-rao');
    expect(await rowCounts(db)).toMatchObject({ users: 1, rules: 0, eventTypes: 0, bookings: 0 });
  });
});
