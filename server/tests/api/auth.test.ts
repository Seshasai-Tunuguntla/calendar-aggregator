import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { meResponseSchema } from '@calendar-aggregator/shared';
import { createApp } from '../../src/app.ts';
import { SESSION_TTL_MS, hashToken } from '../../src/auth/sessions.ts';
import { DEMO_IDS } from '../../src/demo/demoData.ts';
import { useTestDatabase } from '../helpers/db.ts';

const db = useTestDatabase();

const NOW = new Date('2026-10-12T03:00:00Z');
let clock = NOW;
const app = createApp({ db, production: false, now: () => clock, rateLimits: false });

// The session token from a response's Set-Cookie header.
function sessionCookieFrom(res: request.Response): { token: string; header: string } {
  const header = [res.headers['set-cookie'] ?? []].flat().find((c: string) => c.startsWith('session=')) ?? '';
  return { token: header.slice('session='.length).split(';')[0] ?? '', header };
}

async function demoLogin(cookie?: string) {
  const req = request(app).post('/api/auth/demo');
  return cookie ? req.set('Cookie', cookie) : req;
}

describe('POST /api/auth/demo', () => {
  it('signs in as the demo host and returns them', async () => {
    clock = NOW;
    const res = await demoLogin();
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).user).toEqual({
      id: DEMO_IDS.host,
      name: 'Priya Sharma',
      email: 'priya.demo@example.com',
      handle: 'priya',
      timeZone: 'Asia/Kolkata',
      isDemo: true,
    });
  });

  it('sets an httpOnly, SameSite=Lax session cookie for 14 days (not Secure over local http)', async () => {
    const { header } = sessionCookieFrom(await demoLogin());
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).not.toMatch(/; Secure/);
  });

  it('stores only a hash of the session token', async () => {
    const { token } = sessionCookieFrom(await demoLogin());
    const sessions = await db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(sessions)).not.toContain(token);
  });

  it('creates the demo host with their calendars, rules and event types only once', async () => {
    await demoLogin();
    await demoLogin();
    expect(await db.user.count()).toBe(1);
    expect(await db.calendar.count()).toBe(3);
    expect(await db.availabilityRule.count()).toBe(11);
    expect(await db.eventType.count()).toBe(3);
    expect(await db.demoBusyEvent.count()).toBeGreaterThan(20);
  });

  it('copes with two first-ever demo logins at the same moment', async () => {
    const [a, b] = await Promise.all([demoLogin(), demoLogin()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await db.user.count()).toBe(1);
  });

  it('replaces the session it was called with, instead of leaving it valid', async () => {
    const first = sessionCookieFrom(await demoLogin());
    await demoLogin(`session=${first.token}`);
    expect(await db.session.count()).toBe(1);
    expect(await db.session.findUnique({ where: { tokenHash: hashToken(first.token) } })).toBeNull();
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    clock = NOW;
    const { token } = sessionCookieFrom(await demoLogin());
    const res = await request(app).get('/api/auth/me').set('Cookie', `session=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(DEMO_IDS.host);
  });

  it('answers 401 without a cookie or with an unknown token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    const res = await request(app).get('/api/auth/me').set('Cookie', 'session=made-up');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not signed in' });
  });

  it('answers 401 once the session has expired, and deletes it', async () => {
    clock = NOW;
    const { token } = sessionCookieFrom(await demoLogin());
    clock = new Date(NOW.getTime() + SESSION_TTL_MS - 1);
    expect((await request(app).get('/api/auth/me').set('Cookie', `session=${token}`)).status).toBe(200);
    clock = new Date(NOW.getTime() + SESSION_TTL_MS);
    expect((await request(app).get('/api/auth/me').set('Cookie', `session=${token}`)).status).toBe(401);
    expect(await db.session.count()).toBe(0);
    clock = NOW;
  });

  it('is never cached', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session and clears the cookie, so the token stops working', async () => {
    clock = NOW;
    const { token } = sessionCookieFrom(await demoLogin());
    const res = await request(app).post('/api/auth/logout').set('Cookie', `session=${token}`);
    expect(res.status).toBe(204);
    expect(sessionCookieFrom(res).header).toMatch(/^session=;.*Expires=Thu, 01 Jan 1970/);
    expect(await db.session.count()).toBe(0);
    expect((await request(app).get('/api/auth/me').set('Cookie', `session=${token}`)).status).toBe(401);
  });

  it('succeeds without a session, so a stale cookie can always be cleared', async () => {
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
    expect((await request(app).post('/api/auth/logout').set('Cookie', 'session=stale')).status).toBe(204);
  });
});

describe('cross-site requests (CSRF defence in depth)', () => {
  it('blocks a state-changing request from another origin', async () => {
    const res = await request(app).post('/api/auth/demo').set('Host', 'calendar.example').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Cross-site request blocked' });
    expect(await db.session.count()).toBe(0);
  });

  it('blocks Origin: null and a cross-site Sec-Fetch-Site', async () => {
    expect((await request(app).post('/api/auth/logout').set('Origin', 'null')).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', 'same-site')).status).toBe(403);
  });

  it('allows the same origin, and clients that send neither header (curl)', async () => {
    expect((await request(app).post('/api/auth/logout').set('Host', 'calendar.example').set('Origin', 'https://calendar.example')).status).toBe(204);
    expect((await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', 'same-origin')).status).toBe(204);
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
  });

  it('never blocks reads: GET requests are not checked', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });
});
