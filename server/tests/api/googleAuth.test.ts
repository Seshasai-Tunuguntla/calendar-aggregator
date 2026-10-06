import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { decryptToken } from '../../src/auth/tokenCrypto.ts';
import { CALENDAR_SCOPES, GOOGLE_ENDPOINTS, REQUESTED_SCOPES } from '../../src/google/config.ts';
import { tokenContext } from '../../src/google/tokens.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { ALL_SCOPES_GRANTED, FakeGoogle, TEST_GOOGLE_CONFIG, type FakeAccount } from '../helpers/fakeGoogle.ts';
import { createUser } from '../helpers/factories.ts';

const db = useTestDatabase();
const ORIGIN = TEST_GOOGLE_CONFIG.appOrigin;

const SESHA: FakeAccount = { sub: '1000000000000000001', email: 'Sesha.Sai@gmail.com', name: 'Sesha Sai Tunuguntla' };
const WORK: FakeAccount = { sub: '1000000000000000002', email: 'sesha@work.example', name: 'Sesha Sai (Work)' };

let google: FakeGoogle;
let clock: Date;
let app: ReturnType<typeof createApp>;
let browser: TestBrowser;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  google = await FakeGoogle.create();
  clock = new Date();
  app = createApp({ db, production: false, rateLimits: false, now: () => clock, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
  browser = new TestBrowser(app);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The whole dance: our /start redirects to Google, the person approves (or not), Google
// redirects back to our /callback.
async function start(query = '?tz=Asia/Kolkata', b = browser) {
  const res = await b.get(`/api/auth/google/start${query}`);
  expect(res.status).toBe(302);
  return res.headers['location'] as string;
}

async function callback(params: Record<string, string>, b = browser) {
  return b.get(`/api/auth/google/callback?${new URLSearchParams(params)}`);
}

async function signIn(account: FakeAccount, options: { grantScopes?: string[]; query?: string; b?: TestBrowser } = {}) {
  const b = options.b ?? browser;
  const googleUrl = await start(options.query, b);
  return callback(google.approve(googleUrl, account, options.grantScopes ? { grantScopes: options.grantScopes } : {}), b);
}

const googleConnection = (sub: string) =>
  db.calendarConnection.findUnique({ where: { provider_externalAccountId: { provider: 'GOOGLE', externalAccountId: sub } } });

describe('GET /api/auth/google/start', () => {
  it('redirects to Google with a PKCE (S256) code request for offline access and the narrow scopes', async () => {
    const url = new URL(await start());
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_ENDPOINTS.authorization);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: TEST_GOOGLE_CONFIG.clientId,
      redirect_uri: 'http://calendar.test/api/auth/google/callback',
      response_type: 'code',
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'select_account',
    });
    expect(params['scope']?.split(' ')).toEqual(REQUESTED_SCOPES);
    expect(params['code_challenge']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params['state']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params['nonce']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps state, nonce and the PKCE verifier in a short-lived, httpOnly, SameSite=Lax cookie', async () => {
    const res = await browser.get('/api/auth/google/start');
    const header = [res.headers['set-cookie'] ?? []].flat().find((c: string) => c.startsWith('google-oauth=')) ?? '';
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toContain('Max-Age=600');
  });

  it('uses fresh random values every time', async () => {
    const a = new URL(await start()).searchParams;
    const b = new URL(await start()).searchParams;
    for (const name of ['state', 'nonce', 'code_challenge']) expect(a.get(name)).not.toBe(b.get(name));
  });

  it('answers 503 when Google sign-in is not configured', async () => {
    const withoutGoogle = new TestBrowser(createApp({ db, production: false, rateLimits: false }));
    const res = await withoutGoogle.get('/api/auth/google/start');
    expect(res.status).toBe(503);
  });

  it('sends someone who is not signed in back to the login page when they try to connect an account', async () => {
    const res = await browser.get('/api/auth/google/start?intent=connect');
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=signin_required`);
  });

  it("won't let the demo host connect a real Google account", async () => {
    await browser.post('/api/auth/demo');
    const res = await browser.get('/api/auth/google/start?intent=connect');
    expect(res.headers['location']).toBe(`${ORIGIN}/calendars?error=demo_cannot_connect`);
  });
});

describe('GET /api/auth/google/callback: signing in', () => {
  it('creates the user and an encrypted Google connection, signs them in, and goes to the dashboard', async () => {
    const res = await signIn(SESHA);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe(`${ORIGIN}/dashboard`);
    expect(browser.cookies.has('google-oauth')).toBe(false);

    const me = await browser.get('/api/auth/me');
    expect(me.body.user).toMatchObject({ name: 'Sesha Sai Tunuguntla', email: 'sesha.sai@gmail.com', handle: 'sesha-sai-tunuguntla', timeZone: 'Asia/Kolkata', isDemo: false });

    const connection = await googleConnection(SESHA.sub);
    expect(connection).toMatchObject({ accountEmail: 'sesha.sai@gmail.com', status: 'ACTIVE', tokenKeyVersion: 1, grantedScopes: ALL_SCOPES_GRANTED });
    const [refreshToken] = google.refreshTokensIssued;
    // Stored encrypted, not as the token itself, and bound to this account's refresh-token slot.
    expect(connection?.encryptedRefreshToken).not.toContain(refreshToken);
    expect(decryptToken(connection?.encryptedRefreshToken ?? '', 1, TEST_GOOGLE_CONFIG.keyring, tokenContext(SESHA.sub, 'refresh'))).toBe(refreshToken);
    expect(connection?.accessTokenExpiresAt?.getTime()).toBe(clock.getTime() + 3599 * 1000);
  });

  it('sends the PKCE verifier and client credentials only to the token endpoint, from the server', async () => {
    const googleUrl = await start();
    await callback(google.approve(googleUrl, SESHA));
    const exchange = google.requests.find((r) => r.form['grant_type'] === 'authorization_code');
    expect(exchange?.url).toBe(GOOGLE_ENDPOINTS.token);
    expect(exchange?.form['code_verifier']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier never appeared in the browser-visible authorization URL.
    expect(googleUrl).not.toContain(exchange?.form['code_verifier']);
  });

  it('finds the same user on later sign-ins by Google account id, and updates the tokens', async () => {
    await signIn(SESHA);
    const first = await googleConnection(SESHA.sub);
    const again = new TestBrowser(app);
    await signIn(SESHA, { b: again });
    expect(await db.user.count()).toBe(1);
    const second = await googleConnection(SESHA.sub);
    expect(second?.encryptedAccessToken).not.toBe(first?.encryptedAccessToken);
    expect((await again.get('/api/auth/me')).status).toBe(200);
  });

  it("follows the Google account id when the account's email changes", async () => {
    await signIn(SESHA);
    await signIn({ ...SESHA, email: 'sesha.new@gmail.com' }, { b: new TestBrowser(app) });
    expect(await db.user.count()).toBe(1);
    expect(await googleConnection(SESHA.sub)).toMatchObject({ accountEmail: 'sesha.new@gmail.com' });
  });

  it("never signs a different Google account into a user just because the email matches (account takeover)", async () => {
    // Sesha connects a work account; later someone else holds a Google account with that address
    // (e.g. a recycled work email). Their sign-in must not reach Sesha's calendars.
    await signIn(SESHA);
    await signIn(WORK, { query: '?intent=connect' });
    const stranger = new TestBrowser(app);
    await signIn({ sub: '1000000000000000777', email: WORK.email, name: 'Someone Else' }, { b: stranger });
    const me = await stranger.get('/api/auth/me');
    expect(me.body.user.email).toBe('sesha@work.example');
    expect(me.body.user.name).toBe('Someone Else');
    expect(await db.user.count()).toBe(2);
  });

  it.each([
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['EST5EDT', 'EST5EDT'],
    ['+05:30', 'UTC'],
    ['Mars/Olympus_Mons', 'UTC'],
    ['../../etc/passwd', 'UTC'],
    [`Asia/${'K'.repeat(80)}`, 'UTC'],
    ['', 'UTC'],
  ])('validates ?tz=%s as a real IANA zone (stored as %s)', async (tz, stored) => {
    await signIn(SESHA, { query: `?${new URLSearchParams({ tz })}` });
    expect((await browser.get('/api/auth/me')).body.user.timeZone).toBe(stored);
  });

  it('uses UTC when no time zone is sent', async () => {
    await signIn(SESHA, { query: '' });
    expect((await browser.get('/api/auth/me')).body.user.timeZone).toBe('UTC');
  });

  it('gives a second person with the same name a different handle', async () => {
    await signIn(SESHA);
    await signIn({ sub: '1000000000000000099', email: 'other.sesha@gmail.com', name: 'Sesha Sai Tunuguntla' }, { b: new TestBrowser(app) });
    const handles = (await db.user.findMany({ orderBy: { createdAt: 'asc' } })).map((u) => u.handle);
    expect(handles[0]).toBe('sesha-sai-tunuguntla');
    expect(handles[1]).toMatch(/^sesha-sai-tunuguntla-[a-z0-9]{5}$/);
  });

  it('refuses a new Google account whose email already belongs to another user', async () => {
    await createUser(db, { email: 'sesha.sai@gmail.com' });
    const res = await signIn(SESHA);
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=email_in_use`);
    expect(await db.calendarConnection.count()).toBe(0);
  });
});

describe('callback security checks', () => {
  it('rejects a state that does not match the one this browser was given (login CSRF)', async () => {
    const googleUrl = await start();
    const { code } = google.approve(googleUrl, SESHA);
    const res = await callback({ code, state: 'attacker-state' });
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=state_mismatch`);
    expect(google.requests).toHaveLength(0); // the code was never even exchanged
    expect(await db.user.count()).toBe(0);
  });

  it("rejects a callback in a browser that didn't start the sign-in (an attacker's link)", async () => {
    const attackerUrl = await start('', new TestBrowser(app));
    const res = await callback(google.approve(attackerUrl, { sub: '666', email: 'attacker@gmail.com' }));
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=expired`);
    expect(await db.user.count()).toBe(0);
  });

  it('rejects a tampered flow cookie', async () => {
    const googleUrl = await start();
    const [body = '', signature = ''] = (browser.cookies.get('google-oauth') ?? '').split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, intent: 'connect', userId: 'someone-else' })).toString('base64url');
    browser.cookies.set('google-oauth', `${forged}.${signature}`);
    const res = await callback(google.approve(googleUrl, SESHA));
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=expired`);
  });

  it('rejects a flow cookie older than 10 minutes', async () => {
    const googleUrl = await start();
    clock = new Date(clock.getTime() + 10 * 60 * 1000 + 1);
    const res = await callback(google.approve(googleUrl, SESHA));
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=expired`);
  });

  it('cannot be replayed: the code is single-use and the cookie is cleared', async () => {
    const googleUrl = await start();
    const flowCookie = browser.cookies.get('google-oauth') ?? '';
    const params = google.approve(googleUrl, SESHA);
    expect((await callback(params)).headers['location']).toBe(`${ORIGIN}/dashboard`);
    // Replaying the exact same callback, even with the old cookie copied back in.
    const replay = new TestBrowser(app);
    replay.cookies.set('google-oauth', flowCookie);
    expect((await callback(params, replay)).headers['location']).toBe(`${ORIGIN}/login?error=google_error`);
  });

  it('reports a refusal on the consent screen', async () => {
    const res = await callback(google.deny(await start()));
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=access_denied`);
  });

  it.each([
    ['for another app (wrong audience)', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['from another issuer', { iss: 'https://evil.example' }],
    ['that has expired', { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }],
    ['from another sign-in (wrong nonce)', { nonce: 'replayed-nonce' }],
  ])('rejects an ID token %s', async (_label, claims) => {
    google.nextIdTokenClaims = claims;
    const res = await signIn(SESHA);
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=google_error`);
    expect(await db.user.count()).toBe(0);
  });

  it('rejects an ID token signed with a key Google does not publish', async () => {
    google.signNextWithUnknownKey = true;
    const res = await signIn(SESHA);
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=google_error`);
    expect(await db.user.count()).toBe(0);
  });

  it("rejects an account whose email Google hasn't verified", async () => {
    const res = await signIn({ ...SESHA, emailVerified: false });
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=google_error`);
  });

  it('refuses a partial grant without calendar access, and revokes what it was given', async () => {
    const identityOnly = ALL_SCOPES_GRANTED.filter((scope) => !(CALENDAR_SCOPES as readonly string[]).includes(scope));
    const res = await signIn(SESHA, { grantScopes: identityOnly });
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=calendar_permission_missing`);
    expect(await db.user.count()).toBe(0);
    expect(google.requests.at(-1)?.url).toBe(GOOGLE_ENDPOINTS.revocation);
    expect(google.isRevoked(google.refreshTokensIssued[0] ?? '')).toBe(true);
  });

  it('turns a failing token endpoint into an error page, and never logs secrets', async () => {
    const googleUrl = await start();
    const params = google.approve(googleUrl, SESHA);
    google.failNext = { endpoint: 'token', status: 500, error: 'internal_failure' };
    const res = await callback(params);
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=google_error`);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('internal_failure');
    for (const secret of [TEST_GOOGLE_CONFIG.clientSecret, params.code, google.requests[0]?.form['code_verifier'] ?? 'x']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('when Google returns no refresh token', () => {
  it('keeps the stored one if it still works (a normal second sign-in)', async () => {
    await signIn(SESHA);
    const before = await googleConnection(SESHA.sub);
    const res = await signIn(SESHA, { b: new TestBrowser(app) });
    expect(res.headers['location']).toBe(`${ORIGIN}/dashboard`);
    expect(google.refreshTokensIssued).toHaveLength(1);
    const after = await googleConnection(SESHA.sub);
    const decrypt = (ciphertext: string | null | undefined) =>
      decryptToken(ciphertext ?? '', 1, TEST_GOOGLE_CONFIG.keyring, tokenContext(SESHA.sub, 'refresh'));
    expect(decrypt(after?.encryptedRefreshToken)).toBe(decrypt(before?.encryptedRefreshToken));
  });

  it('asks Google again with prompt=consent when there is no usable stored one, and then succeeds', async () => {
    await signIn(SESHA);
    // The stored token is gone (as after "needs reconnect"); Google remembers the earlier consent.
    await db.calendarConnection.updateMany({ where: { externalAccountId: SESHA.sub }, data: { status: 'NEEDS_RECONNECT', encryptedRefreshToken: null } });

    const b = new TestBrowser(app);
    const first = await signIn(SESHA, { b });
    expect(first.status).toBe(303);
    const retry = new URL(first.headers['location'] as string, ORIGIN);
    expect(retry.pathname).toBe('/api/auth/google/start');
    expect(Object.fromEntries(retry.searchParams)).toMatchObject({ consent: '1', hint: 'sesha.sai@gmail.com', intent: 'signin' });

    // Following the retry: Google shows the consent screen and issues a new refresh token.
    const googleUrl = await start(`${retry.search}`, b);
    expect(new URL(googleUrl).searchParams.get('prompt')).toBe('consent');
    expect(new URL(googleUrl).searchParams.get('login_hint')).toBe('sesha.sai@gmail.com');
    const done = await callback(google.approve(googleUrl, SESHA), b);
    expect(done.headers['location']).toBe(`${ORIGIN}/dashboard`);
    expect(await googleConnection(SESHA.sub)).toMatchObject({ status: 'ACTIVE' });
    expect(google.refreshTokensIssued).toHaveLength(2);
  });

  it('gives up instead of looping if even the consent screen returns none', async () => {
    const b = new TestBrowser(app);
    await signIn(SESHA, { b: new TestBrowser(app) });
    await db.calendarConnection.updateMany({ data: { encryptedRefreshToken: null, status: 'NEEDS_RECONNECT' } });
    // A forced-consent flow (consent=1) that still gets no refresh token back. The fake only
    // withholds one when prompt isn't 'consent', so the prompt is changed on Google's side.
    const googleUrl = new URL(await start('?consent=1', b));
    googleUrl.searchParams.set('prompt', 'select_account');
    const res = await callback(google.approve(googleUrl.toString(), SESHA), b);
    expect(res.headers['location']).toBe(`${ORIGIN}/login?error=no_refresh_token`);
  });
});

describe('connecting a second Google account', () => {
  it('adds it to the signed-in user; signing in with it later finds the same user', async () => {
    await signIn(SESHA);
    const res = await signIn(WORK, { query: '?intent=connect' });
    expect(res.headers['location']).toBe(`${ORIGIN}/calendars?connected=1`);
    const connections = await db.calendarConnection.findMany({ orderBy: { createdAt: 'asc' } });
    expect(connections.map((c) => c.accountEmail)).toEqual(['sesha.sai@gmail.com', 'sesha@work.example']);
    expect(new Set(connections.map((c) => c.userId)).size).toBe(1);

    const viaWork = new TestBrowser(app);
    await signIn(WORK, { b: viaWork });
    expect((await viaWork.get('/api/auth/me')).body.user.email).toBe('sesha.sai@gmail.com');
    expect(await db.user.count()).toBe(1);
  });

  it("refuses an account that's already connected to another user", async () => {
    await signIn(WORK, { b: new TestBrowser(app) });
    await signIn(SESHA);
    const res = await signIn(WORK, { query: '?intent=connect' });
    expect(res.headers['location']).toBe(`${ORIGIN}/calendars?error=account_in_use`);
  });

  it('refuses if the browser is now signed in as someone else, so the account never lands on the wrong user', async () => {
    await signIn(SESHA);
    const googleUrl = await start('?intent=connect');
    // Same browser, different user before Google redirects back.
    await browser.post('/api/auth/demo');
    const res = await callback(google.approve(googleUrl, WORK));
    expect(res.headers['location']).toBe(`${ORIGIN}/calendars?error=signin_required`);
    expect(await db.calendarConnection.count({ where: { provider: 'GOOGLE' } })).toBe(1);
  });

  it('refuses if the browser was signed out in the meantime', async () => {
    await signIn(SESHA);
    const googleUrl = await start('?intent=connect');
    await browser.post('/api/auth/logout');
    const res = await callback(google.approve(googleUrl, WORK));
    expect(res.headers['location']).toBe(`${ORIGIN}/calendars?error=signin_required`);
    expect(await db.calendarConnection.count()).toBe(1);
  });
});
