import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionsResponseSchema, disconnectResponseSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount } from '../helpers/fakeGoogle.ts';

const db = useTestDatabase();

const SESHA: FakeAccount = { sub: '2000000000000000001', email: 'sesha.sai@gmail.com', name: 'Sesha Sai' };
const WORK: FakeAccount = { sub: '2000000000000000002', email: 'sesha@work.example', name: 'Sesha (Work)' };

let google: FakeGoogle;
let app: ReturnType<typeof createApp>;
let browser: TestBrowser;

beforeEach(async () => {
  google = await FakeGoogle.create();
  app = createApp({ db, production: false, rateLimits: false, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
  browser = new TestBrowser(app);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(account: FakeAccount, intent: 'signin' | 'connect' = 'signin', b = browser) {
  const start = await b.get(`/api/auth/google/start?intent=${intent}`);
  const params = google.approve(start.headers['location'] as string, account);
  return b.get(`/api/auth/google/callback?${new URLSearchParams(params)}`);
}

async function connections(b = browser) {
  return connectionsResponseSchema.parse((await b.get('/api/connections')).body).connections;
}

describe('GET /api/connections', () => {
  it("lists the user's connections, never their tokens", async () => {
    await signIn(SESHA);
    await signIn(WORK, 'connect');
    const res = await browser.get('/api/connections');
    expect(res.status).toBe(200);
    expect(connectionsResponseSchema.parse(res.body).connections.map((c) => [c.provider, c.accountEmail, c.status, c.canDisconnect])).toEqual([
      ['GOOGLE', 'sesha.sai@gmail.com', 'ACTIVE', true],
      ['GOOGLE', 'sesha@work.example', 'ACTIVE', true],
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/encrypted|refresh|access/i);
  });

  it("doesn't offer to disconnect the only Google account or the demo calendar", async () => {
    await signIn(SESHA);
    expect((await connections()).map((c) => c.canDisconnect)).toEqual([false]);
    const demo = new TestBrowser(app);
    await demo.post('/api/auth/demo');
    expect((await connections(demo)).map((c) => [c.provider, c.canDisconnect])).toEqual([['DEMO', false]]);
  });

  it('requires signing in', async () => {
    expect((await browser.get('/api/connections')).status).toBe(401);
  });
});

describe('DELETE /api/connections/:id', () => {
  it('revokes the refresh token at Google, then deletes the connection and its tokens', async () => {
    await signIn(SESHA);
    await signIn(WORK, 'connect');
    const work = (await connections()).find((c) => c.accountEmail === 'sesha@work.example');
    const workRefreshToken = google.refreshTokensIssued[1] ?? '';

    const res = await browser.delete(`/api/connections/${work?.id}`);
    expect(res.status).toBe(200);
    expect(disconnectResponseSchema.parse(res.body)).toEqual({ revokedAtGoogle: true });
    expect(google.isRevoked(workRefreshToken)).toBe(true);
    expect(google.isRevoked(google.refreshTokensIssued[0] ?? '')).toBe(false);
    expect((await connections()).map((c) => c.accountEmail)).toEqual(['sesha.sai@gmail.com']);
  });

  it("still deletes our copy when Google can't be reached, and says so", async () => {
    await signIn(SESHA);
    await signIn(WORK, 'connect');
    const work = (await connections()).find((c) => c.accountEmail === 'sesha@work.example');
    google.failNext = 'network';
    const res = await browser.delete(`/api/connections/${work?.id}`);
    expect(res.body).toEqual({ revokedAtGoogle: false });
    expect(await db.calendarConnection.count()).toBe(1);
  });

  it('treats a token Google already revoked as revoked', async () => {
    await signIn(SESHA);
    await signIn(WORK, 'connect');
    google.revokeAll(WORK.sub);
    const work = (await connections()).find((c) => c.accountEmail === 'sesha@work.example');
    expect((await browser.delete(`/api/connections/${work?.id}`)).body).toEqual({ revokedAtGoogle: true });
  });

  it('refuses to disconnect the only Google account, which is how the user signs in', async () => {
    await signIn(SESHA);
    const [only] = await connections();
    const res = await browser.delete(`/api/connections/${only?.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/sign in with/);
    expect(google.isRevoked(google.refreshTokensIssued[0] ?? '')).toBe(false);
  });

  it("refuses to disconnect the demo calendar", async () => {
    await browser.post('/api/auth/demo');
    const [demo] = await connections();
    expect((await browser.delete(`/api/connections/${demo?.id}`)).status).toBe(409);
  });

  it("answers 404 for another user's connection, a missing one, or a malformed id", async () => {
    const other = new TestBrowser(app);
    await signIn(SESHA, 'signin', other);
    await signIn(WORK, 'connect', other);
    const [theirs] = await connections(other);

    await browser.post('/api/auth/demo');
    for (const id of [theirs?.id, '0190a5a4-0000-7000-8000-000000000000', 'not-a-uuid']) {
      const res = await browser.delete(`/api/connections/${id}`);
      expect(res.status, String(id)).toBe(404);
      expect(res.body).toEqual({ error: 'Connection not found' });
    }
    expect(await db.calendarConnection.count({ where: { provider: 'GOOGLE' } })).toBe(2);
  });

  it('is blocked without an Origin header (CSRF check)', async () => {
    await signIn(SESHA);
    await signIn(WORK, 'connect');
    const [, work] = await connections();
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const { default: request } = await import('supertest');
    const res = await request(app).delete(`/api/connections/${work?.id}`).set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(await db.calendarConnection.count()).toBe(2);
  });
});
