import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from 'express-rate-limit';
import { createApp } from '../../src/app.ts';
import { PostgresStore } from '../../src/middleware/rateLimitStore.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG } from '../helpers/fakeGoogle.ts';
import { signInWithGoogle } from '../helpers/googleSignIn.ts';
import { fromOurPage } from '../helpers/http.ts';

const db = useTestDatabase();

const WINDOW_MS = 15 * 60 * 1000;
const store = (prefix = 'test:') => {
  const s = new PostgresStore({ db, prefix });
  s.init({ windowMs: WINDOW_MS } as Options);
  return s;
};
const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
const rows = () => db.rateLimit.findMany({ orderBy: { key: 'asc' } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PostgresStore', () => {
  it('counts hits per client in one window, stored under the limiter prefix', async () => {
    const now = Date.now();
    at(now);
    const s = store('demo-login:');
    const first = await s.increment('203.0.113.7');
    const second = await s.increment('203.0.113.7');
    await s.increment('198.51.100.4');

    expect(first).toEqual({ totalHits: 1, resetTime: new Date(now + WINDOW_MS) });
    expect(second).toEqual({ totalHits: 2, resetTime: new Date(now + WINDOW_MS) });
    expect((await rows()).map((row) => [row.key, row.hits])).toEqual([
      ['demo-login:198.51.100.4', 1],
      ['demo-login:203.0.113.7', 2],
    ]);
  });

  it('keeps different limiters apart', async () => {
    await store('a:').increment('203.0.113.7');
    await store('b:').increment('203.0.113.7');
    expect((await rows()).map((row) => row.key)).toEqual(['a:203.0.113.7', 'b:203.0.113.7']);
  });

  it('starts a new window once the old one has ended', async () => {
    const now = Date.now();
    at(now);
    const s = store();
    await s.increment('203.0.113.7');
    await s.increment('203.0.113.7');
    at(now + WINDOW_MS);
    expect(await s.increment('203.0.113.7')).toEqual({ totalHits: 1, resetTime: new Date(now + 2 * WINDOW_MS) });
  });

  it('never loses a count when many hits arrive at once', async () => {
    const s = store();
    await Promise.all(Array.from({ length: 20 }, () => s.increment('203.0.113.7')));
    expect((await rows())[0]?.hits).toBe(20);
  });

  it('get, decrement and resetKey work on the current window only', async () => {
    const s = store();
    await s.increment('203.0.113.7');
    await s.increment('203.0.113.7');
    await s.decrement('203.0.113.7');
    expect((await s.get('203.0.113.7'))?.totalHits).toBe(1);
    await s.resetKey('203.0.113.7');
    expect(await s.get('203.0.113.7')).toBeUndefined();
  });

  it('deletes ended windows of every limiter as new hits come in', async () => {
    const now = Date.now();
    at(now);
    await store('a:').increment('203.0.113.7');
    at(now + WINDOW_MS + 1);
    await store('b:').increment('198.51.100.4');
    expect((await rows()).map((row) => row.key)).toEqual(['b:198.51.100.4']);
  });
});

describe('the demo login limiter', () => {
  const app = createApp({ db, production: false, rateLimits: true });
  const login = (forwardedFor: string) => fromOurPage(request(app).post('/api/auth/demo')).set('X-Forwarded-For', forwardedFor);

  it('allows 30 demo logins per client per 15 minutes, then answers 429', async () => {
    for (let i = 0; i < 30; i++) expect((await login('203.0.113.7')).status).toBe(200);
    const blocked = await login('203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many requests, please try again later' });
    // Another client is unaffected.
    expect((await login('198.51.100.4')).status).toBe(200);
  }, 60_000);

  it("counts a client by the address Vercel's edge added, so faking earlier entries doesn't help", async () => {
    for (let i = 0; i < 30; i++) await login(`10.0.0.${i}, 203.0.113.7`);
    expect((await login('10.9.9.9, 203.0.113.7')).status).toBe(429);
  }, 60_000);
});

describe('the public booking pages limiter', () => {
  const app = createApp({ db, production: false, rateLimits: true });
  const page = (path: string, forwardedFor: string) => request(app).get(`/api/public/book/${path}`).set('X-Forwarded-For', forwardedFor);

  it('counts every public endpoint together in Postgres: 300 per client per 15 minutes, then 429', async () => {
    // A page that doesn't exist still counts, so probing for handles is limited too.
    for (let i = 0; i < 150; i++) {
      expect((await page('nobody/call', '203.0.113.7')).status).toBe(404);
      expect((await page('nobody/call/slots?from=2026-10-12&to=2026-10-13&tz=UTC', '203.0.113.7')).status).toBe(404);
    }
    expect((await page('nobody/call', '203.0.113.7')).status).toBe(429);
    const blocked = await page('nobody/call/slots?from=2026-10-12&to=2026-10-13&tz=UTC', '203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many requests, please try again later' });
    expect(await db.rateLimit.findUnique({ where: { key: 'public:203.0.113.7' } })).toMatchObject({ hits: 302 });
    // Another client is unaffected.
    expect((await page('nobody/call', '198.51.100.4')).status).toBe(404);
  }, 120_000);
});

describe('the booking changes limiter', () => {
  const app = createApp({ db, production: false, rateLimits: true });
  const post = (path: string) => fromOurPage(request(app).post(`/api/public/${path}`)).set('X-Forwarded-For', '203.0.113.9').send({});

  it('allows 10 bookings, cancellations or reschedules per client per 15 minutes, on top of the public limit', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('book/nobody/call/bookings')).status).toBe(404);
      expect((await post(`bookings/${'A'.repeat(43)}/cancel`)).status).toBe(404);
    }
    expect((await post('book/nobody/call/bookings')).status).toBe(429);
    expect((await post(`bookings/${'A'.repeat(43)}/reschedule`)).status).toBe(429);
    // Looking is still allowed: only the public limit applies to it.
    expect((await request(app).get('/api/public/book/nobody/call').set('X-Forwarded-For', '203.0.113.9')).status).toBe(404);
  }, 60_000);
});

describe('the daily limit on making bookings', () => {
  // Monday 12 October 2026, 08:00 in India; the host takes 30-minute bookings all day.
  const NOW = new Date('2026-10-12T02:30:00Z');
  const HOST = { sub: '9200000000000000001', email: 'dana@gmail.com', name: 'Dana Host' };
  const slot = (i: number) => new Date(NOW.getTime() + (i + 1) * 30 * 60_000).toISOString();
  const MINUTE = 60_000;

  it("allows 10 successful bookings with real hosts per client per day; failures and demo bookings don't count", async () => {
    const google = await FakeGoogle.create();
    google.setCalendars(HOST.sub, [{ id: HOST.email, summary: HOST.email, accessRole: 'owner', primary: true }]);
    const app = createApp({ db, production: false, rateLimits: true, now: () => NOW, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
    const host = new TestBrowser(app);
    await signInWithGoogle(host, google, HOST);
    await host.put('/api/availability', {
      timeZone: 'Asia/Kolkata',
      rules: [{ weekday: 1, startMinute: 0, endMinute: 1440 }],
      settings: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, horizonDays: 30, maxPerDay: null },
    });
    await host.post('/api/event-types', { slug: 'call', title: 'Call', durationMinutes: 30, slotStepMinutes: 30 });

    const start = Date.now();
    at(start);
    const book = (path: string, when: string) =>
      fromOurPage(request(app).post(`/api/public/book/${path}/bookings`))
        .set('X-Forwarded-For', '203.0.113.20')
        .send({ start: when, guestName: 'Guest', guestEmail: 'guest@example.com', guestTimeZone: 'UTC' });

    for (let i = 0; i < 9; i++) expect((await book('dana-host/call', slot(i))).status).toBe(201);
    // A failed attempt (the slot is taken) gives its daily count back.
    expect((await book('dana-host/call', slot(0))).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Past the 15-minute limit's window (10 used), but still the same day.
    at(start + 16 * MINUTE);
    expect((await book('dana-host/call', slot(9))).status).toBe(201);
    const blocked = await book('dana-host/call', slot(10));
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "You've made as many bookings as one connection can make in a day. Please try again tomorrow." });
    // Counted in Postgres, shared by every server instance.
    expect((await db.rateLimit.findUnique({ where: { key: 'booking-daily:203.0.113.20' } }))?.hits).toBeGreaterThanOrEqual(10);

    // The demo sends no invitations, so the daily limit doesn't apply to it, and its bookings
    // don't use up any of the client's allowance for real hosts.
    await fromOurPage(request(app).post('/api/auth/demo'));
    const dailyHits = async () => (await db.rateLimit.findUnique({ where: { key: 'booking-daily:203.0.113.20' } }))?.hits;
    const before = await dailyHits();
    const demoSlots = await request(app).get('/api/public/book/priya/30-min-call/slots?from=2026-10-13&to=2026-10-14&tz=Asia/Kolkata');
    expect((await book('priya/30-min-call', demoSlots.body.slots[0].start)).status).toBe(201);
    expect((await book('priya/30-min-call', demoSlots.body.slots[2].start)).status).toBe(201);
    expect(await dailyHits()).toBe(before);

    // A day later, the client can book again.
    at(start + 24 * 60 * MINUTE + 1);
    expect((await book('dana-host/call', slot(10))).status).toBe(201);
  }, 60_000);
});
