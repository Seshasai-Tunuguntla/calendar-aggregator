import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from 'express-rate-limit';
import { createApp } from '../../src/app.ts';
import { PostgresStore } from '../../src/middleware/rateLimitStore.ts';
import { useTestDatabase } from '../helpers/db.ts';
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
