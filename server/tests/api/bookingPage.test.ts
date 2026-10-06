import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingPageStatusSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount, type FakeCalendar } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';

const db = useTestDatabase();

const NOW = new Date('2026-10-12T02:30:00Z');
const HOST: FakeAccount = { sub: '9300000000000000001', email: 'host@gmail.com', name: 'Host' };
const PRIMARY: FakeCalendar = { id: HOST.email, summary: HOST.email, accessRole: 'owner', primary: true };
const TEAM: FakeCalendar = { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' };

let google: FakeGoogle;
let app: ReturnType<typeof createApp>;
let host: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  google.setCalendars(HOST.sub, [PRIMARY, TEAM]);
  app = createApp({ db, production: false, rateLimits: false, now: () => NOW, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks, sleep: async () => {} } });
  host = new TestBrowser(app);
  await signInWithGoogle(host, google, HOST);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const status = async () => bookingPageStatusSchema.parse((await host.get('/api/booking-page/status')).body);

async function setUp() {
  await host.put('/api/availability', {
    timeZone: 'Asia/Kolkata',
    rules: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
    settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 30, maxPerDay: null },
  });
  await host.post('/api/event-types', { slug: 'call', title: 'Call', durationMinutes: 30, slotStepMinutes: 30 });
}

describe('GET /api/booking-page/status', () => {
  it('reports a page that can show times', async () => {
    await setUp();
    expect(await status()).toEqual({ activeEventTypes: 1, hasHours: true, calendarProblem: null });
  });

  it('reports what a new host still has to set up', async () => {
    expect(await status()).toEqual({ activeEventTypes: 0, hasHours: false, calendarProblem: null });
  });

  it("names a calendar that counts as busy but can't be read, so the host can untick it", async () => {
    await setUp();
    google.setCalendars(HOST.sub, [PRIMARY, { ...TEAM, freeBusyError: 'notFound' }]);
    await db.calendar.updateMany({ where: { name: 'Team' }, data: { countsAsBusy: true } });
    expect((await status()).calendarProblem).toEqual({ kind: 'unreadable', calendarName: 'Team', accountEmail: HOST.email });
  });

  it('says when Google is down for now (temporary)', async () => {
    await setUp();
    google.calendarFailures.push(...Array.from({ length: 3 }, () => ({ status: 503, reason: 'backendError' })));
    expect((await status()).calendarProblem).toEqual({ kind: 'temporary', calendarName: null, accountEmail: null });
  });

  it('names the account to reconnect when its Google access was revoked', async () => {
    await setUp();
    google.revokeAccessTokens();
    google.revokeAll(HOST.sub);
    expect((await status()).calendarProblem).toEqual({ kind: 'reconnect', calendarName: null, accountEmail: HOST.email });
  });

  it('goes through the busy-time cache, so repeated visits cost no extra Google requests', async () => {
    await setUp();
    await status();
    const reads = google.calendarRequests.length;
    await status();
    await status();
    expect(google.calendarRequests).toHaveLength(reads);
  });

  it('requires signing in', async () => {
    expect((await new TestBrowser(app).get('/api/booking-page/status')).status).toBe(401);
  });
});
