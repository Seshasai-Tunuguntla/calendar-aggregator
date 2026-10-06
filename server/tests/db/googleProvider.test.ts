import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { GoogleCalendarProvider, googleEventId } from '../../src/calendar/googleProvider.ts';
import { CalendarProviderError, type ConnectionRef } from '../../src/calendar/provider.ts';
import { syncCalendars } from '../../src/calendar/syncCalendars.ts';
import { createGoogleOAuthClient } from '../../src/google/oauthClient.ts';
import { GoogleTokens } from '../../src/google/tokens.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeCalendar } from '../helpers/fakeGoogle.ts';

const db = useTestDatabase();
const ACCOUNT = { sub: '4000000000000000001', email: 'host@gmail.com', name: 'Host' };
const DAY = 24 * 60 * 60 * 1000;

const CALENDARS: FakeCalendar[] = [
  { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', busy: [{ start: '2026-10-12T05:00:00Z', end: '2026-10-12T06:00:00Z' }] },
  { id: 'host@gmail.com', summary: 'host@gmail.com', summaryOverride: 'Me', accessRole: 'owner', primary: true, busy: [{ start: '2026-10-12T04:00:00Z', end: '2026-10-12T04:30:00Z' }] },
  // As on a real account: freeBusy answers notFound for holiday calendars.
  { id: 'en.indian#holiday@group.v.calendar.google.com', summary: 'Holidays in India', accessRole: 'reader', freeBusyError: 'notFound' },
  { id: 'side@group.calendar.google.com', summary: 'Side project', accessRole: 'owner' },
  { id: 'old@group.calendar.google.com', summary: 'Old', accessRole: 'owner', deleted: true },
];

let google: FakeGoogle;
let provider: GoogleCalendarProvider;
let tokens: GoogleTokens;
let connection: ConnectionRef;
const sleeps: number[] = [];

beforeEach(async () => {
  google = await FakeGoogle.create();
  google.setCalendars(ACCOUNT.sub, CALENDARS.map((c) => ({ ...c })));
  sleeps.length = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const app = createApp({ db, production: false, rateLimits: false, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep } });
  const browser = new TestBrowser(app);
  const start = await browser.get('/api/auth/google/start');
  await browser.get(`/api/auth/google/callback?${new URLSearchParams(google.approve(start.headers['location'] as string, ACCOUNT))}`);
  const row = await db.calendarConnection.findFirstOrThrow({ where: { provider: 'GOOGLE' } });
  connection = { id: row.id, userId: row.userId, provider: row.provider };
  tokens = new GoogleTokens({ db, oauth: createGoogleOAuthClient(TEST_GOOGLE_CONFIG, google.fetch), keyring: TEST_GOOGLE_CONFIG.keyring, now: () => new Date() });
  provider = new GoogleCalendarProvider({ tokens, fetch: google.fetch, sleep });
  google.requests.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const range = (from: string, to: string) => ({ start: Date.parse(from), end: Date.parse(to) });

describe('listCalendars', () => {
  it('lists every page, primary first, with the name the user sees and whether they own it', async () => {
    google.calendarListPageSize = 2;
    expect(await provider.listCalendars(connection)).toEqual([
      { externalCalendarId: 'host@gmail.com', name: 'Me', isPrimary: true, canCreateEvents: true },
      { externalCalendarId: 'en.indian#holiday@group.v.calendar.google.com', name: 'Holidays in India', isPrimary: false, canCreateEvents: false },
      { externalCalendarId: 'side@group.calendar.google.com', name: 'Side project', isPrimary: false, canCreateEvents: true },
      { externalCalendarId: 'team@group.calendar.google.com', name: 'Team', isPrimary: false, canCreateEvents: false },
    ]);
    expect(google.calendarRequests).toHaveLength(3);
  });
});

describe('getBusyIntervals', () => {
  it('returns busy time from several calendars in one request, as epoch ms', async () => {
    const intervals = await provider.getBusyIntervals(connection, ['host@gmail.com', 'team@group.calendar.google.com'], range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z'));
    expect(intervals.toSorted((a, b) => a.start - b.start)).toEqual([
      range('2026-10-12T04:00:00Z', '2026-10-12T04:30:00Z'),
      range('2026-10-12T05:00:00Z', '2026-10-12T06:00:00Z'),
    ]);
    expect(google.calendarRequests).toHaveLength(1);
    expect(JSON.parse(google.calendarRequests[0]?.form['body'] ?? '{}')).toEqual({
      timeMin: '2026-10-12T00:00:00.000Z',
      timeMax: '2026-10-13T00:00:00.000Z',
      items: [{ id: 'host@gmail.com' }, { id: 'team@group.calendar.google.com' }],
    });
  });

  it('asks for at most 50 calendars and 60 days per request', async () => {
    const many: FakeCalendar[] = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}@group.calendar.google.com`, summary: `C${i}`, accessRole: 'reader' }));
    google.setCalendars(ACCOUNT.sub, many);
    const start = Date.parse('2026-10-01T00:00:00Z');
    await provider.getBusyIntervals(connection, many.map((c) => c.id), { start, end: start + 150 * DAY });
    const bodies = google.calendarRequests.map((r) => JSON.parse(r.form['body'] ?? '{}') as { timeMin: string; timeMax: string; items: unknown[] });
    // 3 windows (60 + 60 + 30 days) x 3 batches (50 + 50 + 20 calendars).
    expect(bodies).toHaveLength(9);
    expect(Math.max(...bodies.map((b) => b.items.length))).toBe(50);
    expect(Math.max(...bodies.map((b) => Date.parse(b.timeMax) - Date.parse(b.timeMin)))).toBe(60 * DAY);
    expect(bodies.at(-1)?.timeMax).toBe(new Date(start + 150 * DAY).toISOString());
  });

  it("fails closed when a calendar can't be read, naming it (offering slots then could double-book)", async () => {
    const error = await provider
      .getBusyIntervals(connection, ['host@gmail.com', 'gone@group.calendar.google.com'], range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarProviderError);
    expect(error).toMatchObject({ kind: 'not_found', externalCalendarId: 'gone@group.calendar.google.com' });
  });

  it('treats a per-calendar backend error as unavailable', async () => {
    google.setCalendars(ACCOUNT.sub, [{ id: 'flaky@group.calendar.google.com', summary: 'Flaky', accessRole: 'owner', freeBusyError: 'internalError' }]);
    await expect(provider.getBusyIntervals(connection, ['flaky@group.calendar.google.com'], range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z'))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it("makes no request for no calendars or an empty range", async () => {
    expect(await provider.getBusyIntervals(connection, [], range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z'))).toEqual([]);
    expect(await provider.getBusyIntervals(connection, ['host@gmail.com'], range('2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'))).toEqual([]);
    expect(google.calendarRequests).toHaveLength(0);
  });
});

describe('checkBusyAccess', () => {
  it('tells permanently unreadable calendars (notFound) apart from temporary per-calendar errors', async () => {
    google.setCalendars(ACCOUNT.sub, [
      ...CALENDARS,
      { id: 'flaky@group.calendar.google.com', summary: 'Flaky', accessRole: 'reader', freeBusyError: 'backendError' },
    ]);
    const access = await provider.checkBusyAccess(connection, ['host@gmail.com', 'en.indian#holiday@group.v.calendar.google.com', 'flaky@group.calendar.google.com']);
    expect(Object.fromEntries(access)).toEqual({
      'host@gmail.com': 'READABLE',
      'en.indian#holiday@group.v.calendar.google.com': 'UNREADABLE',
      'flaky@group.calendar.google.com': 'UNKNOWN',
    });
    expect(google.calendarRequests).toHaveLength(1);
  });

  it('checks at most 50 calendars per request', async () => {
    const many: FakeCalendar[] = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}@group.calendar.google.com`, summary: `C${i}`, accessRole: 'reader' }));
    google.setCalendars(ACCOUNT.sub, many);
    const access = await provider.checkBusyAccess(connection, many.map((c) => c.id));
    expect(access.size).toBe(120);
    expect([...access.values()].every((a) => a === 'READABLE')).toBe(true);
    expect(google.calendarRequests.map((r) => (JSON.parse(r.form['body'] ?? '{}') as { items: unknown[] }).items.length)).toEqual([50, 50, 20]);
  });

  it('throws (rather than calling anything unreadable) when the whole request fails', async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError' })));
    await expect(provider.checkBusyAccess(connection, ['host@gmail.com'])).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('createEvent and deleteEvent', () => {
  const booking = {
    idempotencyKey: '0190a5a4-2222-7000-8000-00000000abcd',
    externalCalendarId: 'host@gmail.com',
    start: new Date('2026-10-12T07:00:00Z'),
    end: new Date('2026-10-12T07:30:00Z'),
    summary: '30-min call with Alex',
    description: 'Booked via Calendar Aggregator',
    attendees: [{ email: 'alex@example.com', name: 'Alex' }],
  };

  it('creates the event with the guest as an attendee and asks Google to send the invitation', async () => {
    const { externalEventId } = await provider.createEvent(connection, booking);
    expect(externalEventId).toBe('0190a5a422227000800000000000abcd');
    expect(google.events.get(externalEventId)).toMatchObject({
      calendarId: 'host@gmail.com',
      summary: '30-min call with Alex',
      start: '2026-10-12T07:00:00.000Z',
      end: '2026-10-12T07:30:00.000Z',
      attendees: [{ email: 'alex@example.com', displayName: 'Alex' }],
      sendUpdates: 'all',
    });
    // The new event now makes that time busy.
    expect(await provider.getBusyIntervals(connection, ['host@gmail.com'], range('2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z'))).toEqual([
      range('2026-10-12T07:00:00Z', '2026-10-12T07:30:00Z'),
    ]);
  });

  it('is safe to retry: the same idempotency key gives the same event, created once', async () => {
    const first = await provider.createEvent(connection, booking);
    const retry = await provider.createEvent(connection, booking);
    expect(retry).toEqual(first);
    expect(google.events.size).toBe(1);
  });

  it("refuses to create an event in a calendar the user doesn't own", async () => {
    const error = await provider.createEvent(connection, { ...booking, externalCalendarId: 'team@group.calendar.google.com' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'not_found', externalCalendarId: 'team@group.calendar.google.com' });
    expect(google.events.size).toBe(0);
  });

  it('deletes the event (Google tells the guest), and deleting again or a missing one succeeds', async () => {
    const { externalEventId } = await provider.createEvent(connection, booking);
    await provider.deleteEvent(connection, 'host@gmail.com', externalEventId);
    expect(google.events.get(externalEventId)).toMatchObject({ deleted: true, sendUpdates: 'all' });
    await provider.deleteEvent(connection, 'host@gmail.com', externalEventId); // 410 Gone
    await provider.deleteEvent(connection, 'host@gmail.com', 'neverexisted123'); // 404
  });

  it('turns the idempotency key into a valid Google event id (base32hex)', () => {
    expect(googleEventId('0190A5A4-2222-7000-8000-00000000ABCD')).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});

describe('error handling', () => {
  const day = range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z');
  const busy = () => provider.getBusyIntervals(connection, ['host@gmail.com'], day);

  it('refreshes the access token once when Google rejects it (401), then retries', async () => {
    google.revokeAccessTokens();
    await expect(busy()).resolves.toHaveLength(1);
    const kinds = google.requests.map((r) => r.form['grant_type'] ?? 'calendar');
    expect(kinds).toEqual(['calendar', 'refresh_token', 'calendar']);
  });

  it("gives up with 'auth' if the refreshed token is rejected too", async () => {
    google.calendarFailures.push({ status: 401, reason: 'authError' }, { status: 401, reason: 'authError' });
    await expect(busy()).rejects.toMatchObject({ kind: 'auth' });
  });

  it("marks the connection NEEDS_RECONNECT when access was revoked at Google", async () => {
    google.revokeAccessTokens();
    google.revokeAll(ACCOUNT.sub);
    await expect(busy()).rejects.toMatchObject({ kind: 'auth' });
    expect(await db.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ status: 'NEEDS_RECONNECT' });
  });

  it('marks the connection NEEDS_RECONNECT when a scope is missing (403 insufficientPermissions)', async () => {
    google.calendarFailures.push({ status: 403, reason: 'insufficientPermissions' });
    await expect(busy()).rejects.toMatchObject({ kind: 'auth' });
    expect(await db.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ status: 'NEEDS_RECONNECT' });
  });

  it('retries rate limits with backoff, honouring Retry-After, then succeeds', async () => {
    google.calendarFailures.push({ status: 429, reason: 'rateLimitExceeded', retryAfter: '2' }, { status: 403, reason: 'userRateLimitExceeded' });
    await expect(busy()).resolves.toHaveLength(1);
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThan(600);
  });

  it("gives up after two retries: 'rate_limited' for rate limits, 'unavailable' for server errors", async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 403, reason: 'rateLimitExceeded' })));
    await expect(busy()).rejects.toMatchObject({ kind: 'rate_limited' });
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 500, reason: 'backendError' })));
    await expect(busy()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(sleeps).toHaveLength(4);
  });

  it("retries network failures, then reports 'unavailable'", async () => {
    google.calendarFailures.push('network', 'network');
    await expect(busy()).resolves.toHaveLength(1);
    google.calendarFailures.push('network', 'network', 'network');
    await expect(busy()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('never puts the access token in an error message', async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 500, reason: 'backendError' })));
    const error = await busy().catch((e: unknown) => e);
    const token = await tokens.accessToken(connection.id);
    expect(String(error)).not.toContain(token);
  });

  it('refuses to serve a demo connection', async () => {
    await expect(provider.listCalendars({ ...connection, provider: 'DEMO' })).rejects.toThrow("can't serve a DEMO connection");
  });
});

// A connection whose stored access token has already expired, so every call refreshes it first.
const expireAccessToken = () => db.calendarConnection.update({ where: { id: connection.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) } });
const withLimit = (callBudgetMs: number) => new GoogleCalendarProvider({ tokens, fetch: google.fetch, sleep: async () => {}, callBudgetMs });

describe('the time limit on a call', () => {
  const day = range('2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z');
  it('refreshes an expired access token first, inside the same call', async () => {
    await expireAccessToken();
    await expect(withLimit(300).getBusyIntervals(connection, ['host@gmail.com'], day)).resolves.toHaveLength(1);
    expect(google.requests.map((r) => r.form['grant_type'] ?? 'calendar')).toEqual(['refresh_token', 'calendar']);
  });

  it('counts the refresh against the call\'s time limit: a slow refresh ends the call at the limit', async () => {
    await expireAccessToken();
    google.tokenDelays.push(5_000);
    const started = Date.now();
    await expect(withLimit(300).getBusyIntervals(connection, ['host@gmail.com'], day)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(google.calendarRequests).toHaveLength(0);
    // Slow isn't revoked: the connection still works afterwards.
    expect(await db.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ status: 'ACTIVE' });
    await expect(withLimit(300).getBusyIntervals(connection, ['host@gmail.com'], day)).resolves.toHaveLength(1);
  });
});

// The connection's Calendar rows, by name.
const rows = () => db.calendar.findMany({ where: { connectionId: connection.id }, orderBy: { name: 'asc' } });

describe('syncCalendars', () => {
  it('runs on sign-in: calendars the user owns count as busy, subscribed and shared ones do not, and access is recorded', async () => {
    expect((await rows()).map((c) => [c.name, c.countsAsBusy, c.canCreateEvents, c.isPrimary, c.busyAccess])).toEqual([
      ['Holidays in India', false, false, false, 'UNREADABLE'],
      ['Me', true, true, true, 'READABLE'],
      ['Side project', true, true, false, 'READABLE'],
      ['Team', false, false, false, 'READABLE'],
    ]);
  });

  it("doesn't let an owned calendar that can't be read count as busy by default", async () => {
    google.setCalendars(ACCOUNT.sub, [{ id: 'odd@group.calendar.google.com', summary: 'Odd', accessRole: 'owner', freeBusyError: 'notFound' }]);
    await syncCalendars(db, provider, connection);
    expect((await rows()).map((c) => [c.name, c.countsAsBusy, c.busyAccess])).toEqual([['Odd', false, 'UNREADABLE']]);
  });

  it("saves the list with access UNKNOWN when only the access check fails (temporary), never UNREADABLE", async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'freeBusy' as const })));
    await syncCalendars(db, provider, connection);
    expect((await rows()).map((c) => [c.name, c.busyAccess])).toEqual([
      ['Holidays in India', 'UNKNOWN'],
      ['Me', 'UNKNOWN'],
      ['Side project', 'UNKNOWN'],
      ['Team', 'UNKNOWN'],
    ]);
  });

  it("keeps the host's choices, updates names, and removes calendars that are gone", async () => {
    const team = (await rows()).find((c) => c.name === 'Team');
    await db.calendar.update({ where: { id: team?.id ?? '' }, data: { countsAsBusy: true } });
    google.setCalendars(ACCOUNT.sub, [
      { id: 'host@gmail.com', summary: 'host@gmail.com', summaryOverride: 'Me', accessRole: 'owner', primary: true },
      { id: 'team@group.calendar.google.com', summary: 'Team (renamed)', accessRole: 'writer' },
    ]);
    await syncCalendars(db, provider, connection);
    expect((await rows()).map((c) => [c.name, c.countsAsBusy])).toEqual([
      ['Me', true],
      ['Team (renamed)', true],
    ]);
  });
});
