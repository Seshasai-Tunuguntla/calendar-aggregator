import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarResponseSchema, calendarsResponseSchema, type Calendar } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { CANT_CHECK_NOW, UNREADABLE_CALENDAR } from '../../src/routes/calendars.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount, type FakeCalendar } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';

const db = useTestDatabase();

const HOST: FakeAccount = { sub: '5000000000000000001', email: 'host@gmail.com', name: 'Host' };
const WORK: FakeAccount = { sub: '5000000000000000002', email: 'host@work.example', name: 'Host (Work)' };
const HOLIDAY_ID = 'en.indian#holiday@group.v.calendar.google.com';

const TEAM: FakeCalendar = { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' };
const HOST_CALENDARS: FakeCalendar[] = [
  { id: 'host@gmail.com', summary: 'host@gmail.com', summaryOverride: 'Me', accessRole: 'owner', primary: true },
  // Google's freeBusy answers notFound for holiday calendars (checked on a real account).
  { id: HOLIDAY_ID, summary: 'Holidays in India', accessRole: 'reader', freeBusyError: 'notFound' },
  TEAM,
];

let google: FakeGoogle;
let app: ReturnType<typeof createApp>;
let browser: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  google.setCalendars(HOST.sub, HOST_CALENDARS.map((c) => ({ ...c })));
  google.setCalendars(WORK.sub, [{ id: 'host@work.example', summary: 'host@work.example', accessRole: 'owner', primary: true }]);
  app = createApp({ db, production: false, rateLimits: false, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep: async () => {} } });
  browser = new TestBrowser(app);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function calendars(b = browser): Promise<Calendar[]> {
  return calendarsResponseSchema.parse((await b.get('/api/calendars')).body).calendars;
}

const byName = async (name: string) => {
  const calendar = (await calendars()).find((c) => c.name === name);
  if (!calendar) throw new Error(`No calendar named ${name}`);
  return calendar;
};

const summary = (list: Calendar[]) => list.map((c) => [c.name, c.countsAsBusy, c.busyAccess]);

describe('GET /api/calendars', () => {
  it('lists every account\'s calendars after sign-in, with which can be read and which count as busy', async () => {
    await signInWithGoogle(browser, google, HOST);
    await signInWithGoogle(browser, google, WORK, { intent: 'connect' });

    const list = await calendars();
    expect(list.map((c) => [c.accountEmail, c.name, c.isPrimary, c.canCreateEvents, c.countsAsBusy, c.busyAccess, c.connectionStatus])).toEqual([
      ['host@gmail.com', 'Me', true, true, true, 'READABLE', 'ACTIVE'],
      ['host@gmail.com', 'Holidays in India', false, false, false, 'UNREADABLE', 'ACTIVE'],
      ['host@gmail.com', 'Team', false, false, false, 'READABLE', 'ACTIVE'],
      ['host@work.example', 'host@work.example', true, true, true, 'READABLE', 'ACTIVE'],
    ]);
  });

  it("marks calendars UNKNOWN, not unreadable, when the access check fails for a temporary reason", async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError', only: 'freeBusy' as const })));
    await signInWithGoogle(browser, google, HOST);
    // The list is still saved; the host's own calendar still counts as busy by default.
    expect(summary(await calendars())).toEqual([
      ['Me', true, 'UNKNOWN'],
      ['Holidays in India', false, 'UNKNOWN'],
      ['Team', false, 'UNKNOWN'],
    ]);
  });

  it('marks only the affected calendar UNKNOWN when Google reports a temporary error for it', async () => {
    google.setCalendars(HOST.sub, [...HOST_CALENDARS.slice(0, 2), { ...TEAM, freeBusyError: 'backendError' }]);
    await signInWithGoogle(browser, google, HOST);
    expect(summary(await calendars())).toEqual([
      ['Me', true, 'READABLE'],
      ['Holidays in India', false, 'UNREADABLE'],
      ['Team', false, 'UNKNOWN'],
    ]);
  });

  it('requires signing in', async () => {
    expect((await browser.get('/api/calendars')).status).toBe(401);
  });
});

describe('POST /api/calendars/sync', () => {
  beforeEach(async () => {
    await signInWithGoogle(browser, google, HOST);
  });

  it('picks up new, renamed and removed calendars and checks them, keeping the host\'s choices', async () => {
    await browser.patch(`/api/calendars/${(await byName('Me')).id}`, { countsAsBusy: false });
    google.setCalendars(HOST.sub, [
      { id: 'host@gmail.com', summary: 'host@gmail.com', summaryOverride: 'Me (renamed)', accessRole: 'owner', primary: true },
      { id: HOLIDAY_ID, summary: 'Holidays in India', accessRole: 'reader', freeBusyError: 'notFound' },
      { id: 'side@group.calendar.google.com', summary: 'Side project', accessRole: 'owner' },
    ]);
    const res = await browser.post('/api/calendars/sync');
    expect(res.status).toBe(200);
    expect(summary(calendarsResponseSchema.parse(res.body).calendars)).toEqual([
      ['Me (renamed)', false, 'READABLE'],
      ['Holidays in India', false, 'UNREADABLE'],
      ['Side project', true, 'READABLE'],
    ]);
  });

  it("keeps the calendars, marked UNKNOWN, when Google can't list them right now, and recovers on the next sync", async () => {
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 500, reason: 'backendError' })));
    const res = await browser.post('/api/calendars/sync');
    expect(res.status).toBe(200);
    expect(summary(calendarsResponseSchema.parse(res.body).calendars)).toEqual([
      ['Me', true, 'UNKNOWN'],
      ['Holidays in India', false, 'UNKNOWN'],
      ['Team', false, 'UNKNOWN'],
    ]);

    await browser.post('/api/calendars/sync');
    expect(summary(await calendars())).toEqual([
      ['Me', true, 'READABLE'],
      ['Holidays in India', false, 'UNREADABLE'],
      ['Team', false, 'READABLE'],
    ]);
  });

  it('leaves the calendars as they were when access was revoked, and the account shows "needs reconnect"', async () => {
    const before = await calendars();
    google.revokeAccessTokens();
    google.revokeAll(HOST.sub);
    await browser.post('/api/calendars/sync');
    const after = await calendars();
    expect(after.map((c) => [c.name, c.busyAccess])).toEqual(before.map((c) => [c.name, c.busyAccess]));
    expect(after.every((c) => c.connectionStatus === 'NEEDS_RECONNECT')).toBe(true);
  });
});

describe('PATCH /api/calendars/:id', () => {
  beforeEach(async () => {
    await signInWithGoogle(browser, google, HOST);
  });

  it('ticks a calendar that can be read, after checking it with Google', async () => {
    const team = await byName('Team');
    google.requests.length = 0;
    const res = await browser.patch(`/api/calendars/${team.id}`, { countsAsBusy: true });
    expect(res.status).toBe(200);
    expect(calendarResponseSchema.parse(res.body).calendar).toMatchObject({ name: 'Team', countsAsBusy: true, busyAccess: 'READABLE' });
    expect(google.calendarRequests.map((r) => new URL(r.url).pathname.split('/').pop())).toEqual(['freeBusy']);
  });

  it("refuses a calendar whose busy times can't be read (permanent), and records that", async () => {
    const holidays = await byName('Holidays in India');
    const res = await browser.patch(`/api/calendars/${holidays.id}`, { countsAsBusy: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: UNREADABLE_CALENDAR });
    expect(await byName('Holidays in India')).toMatchObject({ countsAsBusy: false, busyAccess: 'UNREADABLE' });
  });

  it("says \"can't check right now\" when Google fails temporarily, without marking the calendar unreadable", async () => {
    const team = await byName('Team');
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError' })));
    const res = await browser.patch(`/api/calendars/${team.id}`, { countsAsBusy: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: CANT_CHECK_NOW });
    expect(await byName('Team')).toMatchObject({ countsAsBusy: false, busyAccess: 'UNKNOWN' });

    // Rate limits are temporary too.
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 429, reason: 'rateLimitExceeded' })));
    expect((await browser.patch(`/api/calendars/${team.id}`, { countsAsBusy: true })).status).toBe(503);

    // Once Google is back, the same request works.
    expect((await browser.patch(`/api/calendars/${team.id}`, { countsAsBusy: true })).status).toBe(200);
    expect(await byName('Team')).toMatchObject({ countsAsBusy: true, busyAccess: 'READABLE' });
  });

  it("treats a temporary error for that one calendar as \"can't check right now\" too", async () => {
    google.setCalendars(HOST.sub, [...HOST_CALENDARS.slice(0, 2), { ...TEAM, freeBusyError: 'internalError' }]);
    const res = await browser.patch(`/api/calendars/${(await byName('Team')).id}`, { countsAsBusy: true });
    expect(res.status).toBe(503);
    expect(await byName('Team')).toMatchObject({ countsAsBusy: false, busyAccess: 'UNKNOWN' });
  });

  it('asks the host to reconnect when Google access was revoked', async () => {
    google.revokeAccessTokens();
    google.revokeAll(HOST.sub);
    const res = await browser.patch(`/api/calendars/${(await byName('Team')).id}`, { countsAsBusy: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Reconnect host@gmail.com to use its calendars' });
  });

  it('always lets the host untick a calendar, even with Google down', async () => {
    google.calendarFailures.push(...Array.from({ length: 10 }, () => 'network' as const));
    const res = await browser.patch(`/api/calendars/${(await byName('Me')).id}`, { countsAsBusy: false });
    expect(res.status).toBe(200);
    expect(await byName('Me')).toMatchObject({ countsAsBusy: false });
  });

  it("can't change another user's calendar, and validates the body", async () => {
    const team = await byName('Team');
    const other = new TestBrowser(app);
    await signInWithGoogle(other, google, WORK);
    expect((await other.patch(`/api/calendars/${team.id}`, { countsAsBusy: false })).status).toBe(404);
    expect((await browser.patch('/api/calendars/not-a-uuid', { countsAsBusy: false })).status).toBe(404);
    expect((await browser.patch(`/api/calendars/${team.id}`, { countsAsBusy: 'yes' })).status).toBe(400);
  });
});

describe('the demo host', () => {
  it("has a holiday calendar that, as with Google, can't count as busy; its own calendars can be toggled", async () => {
    const demo = new TestBrowser(app);
    await demo.post('/api/auth/demo');
    const list = await calendars(demo);
    expect(summary(list)).toEqual([
      ['Work', true, 'READABLE'],
      ['Holidays in India', false, 'UNREADABLE'],
      ['Personal', true, 'READABLE'],
    ]);
    const id = (name: string) => list.find((c) => c.name === name)?.id ?? '';
    expect((await demo.patch(`/api/calendars/${id('Holidays in India')}`, { countsAsBusy: true })).status).toBe(409);
    expect((await demo.patch(`/api/calendars/${id('Personal')}`, { countsAsBusy: false })).status).toBe(200);
    expect((await demo.patch(`/api/calendars/${id('Personal')}`, { countsAsBusy: true })).status).toBe(200);
  });
});
