import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { parseKeyring } from '../../src/auth/tokenCrypto.ts';
import { CALENDAR_API } from '../../src/calendar/googleProvider.ts';
import { CALENDAR_SCOPES, GOOGLE_ENDPOINTS, type GoogleAuthConfig } from '../../src/google/config.ts';

// A stand-in for Google's OAuth server, used through the app's injected fetch. It behaves like
// Google where it matters for security: authorization codes are single-use and bound to the PKCE
// challenge (the verifier is checked at the token endpoint), ID tokens are real RS256 JWTs signed
// with a key published in a JWKS, refresh tokens can be revoked (then they fail with
// invalid_grant), and a refresh token is only issued on first consent or with prompt=consent.

export const TEST_GOOGLE_CONFIG: GoogleAuthConfig = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-client-secret-never-logged',
  appOrigin: 'http://calendar.test',
  redirectUri: 'http://calendar.test/api/auth/google/callback',
  cookieSecret: randomBytes(32),
  keyring: parseKeyring(`1:${randomBytes(32).toString('base64')}`),
};

export interface FakeAccount {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

// Google reports the identity scopes in their long form.
const IDENTITY_SCOPES_GRANTED = ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
export const ALL_SCOPES_GRANTED = [...IDENTITY_SCOPES_GRANTED, ...CALENDAR_SCOPES];

// A calendar in the fake account. accessRole as Google reports it; busy is what freeBusy returns.
export interface FakeCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary?: boolean;
  deleted?: boolean;
  busy?: { start: string; end: string }[];
  /** freeBusy reports this error for the calendar instead of its busy times. */
  freeBusyError?: string;
}

export interface FakeEvent {
  id: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  attendees: { email: string; displayName?: string }[];
  sendUpdates: string | null;
  deleted: boolean;
}

interface IssuedCode {
  account: FakeAccount;
  nonce: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  issueRefreshToken: boolean;
  used: boolean;
}

export class FakeGoogle {
  readonly jwks: JWTVerifyGetKey;
  /** Every request the app made, for asserting what was (and wasn't) sent. */
  readonly requests: { url: string; form: Record<string, string> }[] = [];
  /** Merged into the next ID token's claims (e.g. a wrong audience), then cleared. */
  nextIdTokenClaims: JWTPayload | null = null;
  /** Sign the next ID token with a key that isn't in the JWKS. */
  signNextWithUnknownKey = false;
  /** Return a new refresh token on every refresh (Google may rotate them). */
  rotateRefreshTokens = false;
  /** Make the next call to this endpoint fail like this, then behave normally again. */
  failNext: { endpoint: 'token' | 'revoke'; status: number; error: string } | 'network' | null = null;

  readonly #privateKey: CryptoKey;
  readonly #otherKey: CryptoKey;
  readonly #codes = new Map<string, IssuedCode>();
  readonly #refreshTokens = new Map<string, { account: FakeAccount; revoked: boolean }>();
  readonly #accessTokens = new Map<string, { sub: string; revoked: boolean }>();
  readonly #calendars = new Map<string, FakeCalendar[]>();
  /** Events created through the API, by id. */
  readonly events = new Map<string, FakeEvent>();
  /** calendarList page size (Google's default is 100; small values test pagination). */
  calendarListPageSize = 100;
  /**
   * Calendar API responses to give before behaving normally: each is used once, in order. `only`
   * limits one to an endpoint, e.g. to let the calendar list work while freeBusy fails.
   */
  /**
   * Slow Calendar API answers, each used once, in order: the answer comes after `ms`, unless the
   * caller gives up first (its AbortSignal), as with a real network request. `afterApplying`: the
   * change happens at once and only the answer is late (Google acted, the caller timed out).
   */
  /** Slow answers from the OAuth token endpoint (refreshes and code exchanges), in ms, each used once; honours the caller's AbortSignal. */
  readonly tokenDelays: number[] = [];
  // `until`: also wait for this to settle, for tests that need one request held while another
  // happens, whatever the timing.
  readonly calendarDelays: { ms: number; only?: 'calendarList' | 'freeBusy' | 'events'; afterApplying?: boolean; until?: Promise<unknown> }[] = [];
  readonly calendarFailures: (
    | { status: number; reason: string; retryAfter?: string; only?: 'calendarList' | 'freeBusy' | 'events'; afterApplying?: boolean }
    | 'network'
  )[] = [];

  readonly #consented = new Set<string>();

  private constructor(privateKey: CryptoKey, otherKey: CryptoKey, jwks: JWTVerifyGetKey) {
    this.#privateKey = privateKey;
    this.#otherKey = otherKey;
    this.jwks = jwks;
  }

  static async create(): Promise<FakeGoogle> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-key-1', alg: 'RS256', use: 'sig' };
    return new FakeGoogle(privateKey, other.privateKey, createLocalJWKSet({ keys: [jwk] }));
  }

  // The person on Google's consent screen clicks Continue. Reads the URL our app redirected to,
  // checks it's a proper request, and returns what Google would put on the callback URL.
  approve(authorizationUrl: string, account: FakeAccount, { grantScopes = ALL_SCOPES_GRANTED }: { grantScopes?: string[] } = {}) {
    const url = new URL(authorizationUrl);
    const param = (name: string) => url.searchParams.get(name) ?? '';
    if (`${url.origin}${url.pathname}` !== GOOGLE_ENDPOINTS.authorization) throw new Error('Not Google');
    if (param('client_id') !== TEST_GOOGLE_CONFIG.clientId) throw new Error('Wrong client_id');
    if (param('response_type') !== 'code' || param('code_challenge_method') !== 'S256') throw new Error('Not a PKCE code flow');

    const firstConsent = !this.#consented.has(account.sub);
    this.#consented.add(account.sub);
    const code = `code-${randomBytes(12).toString('hex')}`;
    this.#codes.set(code, {
      account,
      nonce: param('nonce'),
      challenge: param('code_challenge'),
      redirectUri: param('redirect_uri'),
      scopes: grantScopes,
      issueRefreshToken: param('access_type') === 'offline' && (firstConsent || param('prompt') === 'consent'),
      used: false,
    });
    return { code, state: param('state') };
  }

  deny(authorizationUrl: string) {
    return { error: 'access_denied', state: new URL(authorizationUrl).searchParams.get('state') ?? '' };
  }

  isRevoked(refreshToken: string): boolean {
    return this.#refreshTokens.get(refreshToken)?.revoked ?? false;
  }

  /** Revoke from Google's side, as when a user removes the app at myaccount.google.com. */
  revokeAll(sub: string): void {
    for (const token of this.#refreshTokens.values()) if (token.account.sub === sub) token.revoked = true;
  }

  get refreshTokensIssued(): string[] {
    return [...this.#refreshTokens.keys()];
  }

  setCalendars(sub: string, calendars: FakeCalendar[]): void {
    this.#calendars.set(sub, calendars);
  }

  /** Invalidate every access token (as if they had all expired early), keeping refresh tokens. */
  revokeAccessTokens(): void {
    for (const token of this.#accessTokens.values()) token.revoked = true;
  }

  get calendarRequests() {
    return this.requests.filter((r) => r.url.startsWith(CALENDAR_API));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(CALENDAR_API)) {
      const endpoint = url.includes('/calendarList') ? 'calendarList' : url.includes('/freeBusy') ? 'freeBusy' : 'events';
      const index = this.calendarDelays.findIndex((d) => !d.only || d.only === endpoint);
      const [delay] = index === -1 ? [] : this.calendarDelays.splice(index, 1);
      if (!delay) return this.#calendarApi(url, init);
      if (delay.afterApplying) {
        const response = await this.#calendarApi(url, init);
        await waitOrAbort(delay.ms, init?.signal);
        return response;
      }
      await waitOrAbort(delay.ms, init?.signal, delay.until);
      return this.#calendarApi(url, init);
    }
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    this.requests.push({ url, form });

    const failure = this.failNext;
    if (failure === 'network') {
      this.failNext = null;
      throw new TypeError('fetch failed');
    }
    const endpoint = url === GOOGLE_ENDPOINTS.token ? 'token' : url === GOOGLE_ENDPOINTS.revocation ? 'revoke' : null;
    const tokenDelay = endpoint === 'token' ? this.tokenDelays.shift() : undefined;
    if (tokenDelay !== undefined) await waitOrAbort(tokenDelay, init?.signal);
    if (failure && failure.endpoint === endpoint) {
      this.failNext = null;
      return Response.json({ error: failure.error }, { status: failure.status });
    }

    if (endpoint === 'token' && form['grant_type'] === 'authorization_code') return this.#exchangeCode(form);
    if (endpoint === 'token' && form['grant_type'] === 'refresh_token') return this.#refresh(form);
    if (endpoint === 'revoke') return this.#revoke(form);
    return Response.json({ error: 'not_found' }, { status: 404 });
  };

  async #exchangeCode(form: Record<string, string>): Promise<Response> {
    if (form['client_id'] !== TEST_GOOGLE_CONFIG.clientId || form['client_secret'] !== TEST_GOOGLE_CONFIG.clientSecret) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    const issued = this.#codes.get(form['code'] ?? '');
    if (!issued || issued.used || issued.redirectUri !== form['redirect_uri']) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    issued.used = true;
    // PKCE: the verifier must hash to the challenge sent at the start.
    const challenge = createHash('sha256').update(form['code_verifier'] ?? '').digest('base64url');
    if (challenge !== issued.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });

    const accessToken = this.#newAccessToken(issued.account.sub);
    let refreshToken: string | undefined;
    if (issued.issueRefreshToken) {
      refreshToken = `refresh-${randomBytes(16).toString('hex')}`;
      this.#refreshTokens.set(refreshToken, { account: issued.account, revoked: false });
    }
    return Response.json({
      access_token: accessToken,
      expires_in: 3599,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: issued.scopes.join(' '),
      token_type: 'Bearer',
      id_token: await this.#idToken(issued.account, issued.nonce),
    });
  }

  #refresh(form: Record<string, string>): Response {
    const token = this.#refreshTokens.get(form['refresh_token'] ?? '');
    if (!token || token.revoked) return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
    let rotated: string | undefined;
    if (this.rotateRefreshTokens) {
      token.revoked = true;
      rotated = `refresh-${randomBytes(16).toString('hex')}`;
      this.#refreshTokens.set(rotated, { account: token.account, revoked: false });
    }
    return Response.json({
      access_token: this.#newAccessToken(token.account.sub),
      expires_in: 3599,
      ...(rotated ? { refresh_token: rotated } : {}),
      scope: ALL_SCOPES_GRANTED.join(' '),
      token_type: 'Bearer',
    });
  }

  #revoke(form: Record<string, string>): Response {
    const token = form['token'] ?? '';
    const refresh = this.#refreshTokens.get(token);
    const access = this.#accessTokens.get(token);
    if (!refresh && !access) return Response.json({ error: 'invalid_token' }, { status: 400 });
    if (refresh) refresh.revoked = true;
    if (access) access.revoked = true;
    return new Response(null, { status: 200 });
  }

  #newAccessToken(sub: string): string {
    const token = `access-${randomBytes(16).toString('hex')}`;
    this.#accessTokens.set(token, { sub, revoked: false });
    return token;
  }

  // The Calendar API: the four endpoints the provider uses.
  async #calendarApi(url: string, init: RequestInit | undefined): Promise<Response> {
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    this.requests.push({ url, form: { method, body: JSON.stringify(body ?? null), authorization: headers.get('Authorization') ?? '' } });

    const endpoint = url.includes('/calendarList') ? 'calendarList' : url.includes('/freeBusy') ? 'freeBusy' : 'events';
    const index = this.calendarFailures.findIndex((f) => f === 'network' || !f.only || f.only === endpoint);
    const [failure] = index === -1 ? [] : this.calendarFailures.splice(index, 1);
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure) {
      // afterApplying: the change happens, but the answer is lost (like a timeout after Google acted).
      if (failure.afterApplying) await this.#handleCalendarApi(url, method, body, headers);
      return Response.json(
        { error: { code: failure.status, message: 'fake', errors: [{ domain: 'global', reason: failure.reason }] } },
        { status: failure.status, headers: failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {} },
      );
    }
    return this.#handleCalendarApi(url, method, body, headers);
  }

  async #handleCalendarApi(url: string, method: string, body: unknown, headers: Headers): Promise<Response> {
    const token = this.#accessTokens.get((headers.get('Authorization') ?? '').replace(/^Bearer /, ''));
    if (!token || token.revoked) {
      return Response.json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, { status: 401 });
    }
    const calendars = this.#calendars.get(token.sub) ?? [];
    const { pathname, searchParams } = new URL(url);
    const path = pathname.slice(new URL(CALENDAR_API).pathname.length);

    if (method === 'GET' && path === '/users/me/calendarList') {
      const offset = Number(searchParams.get('pageToken') ?? 0);
      const page = calendars.slice(offset, offset + this.calendarListPageSize);
      const next = offset + this.calendarListPageSize < calendars.length ? String(offset + this.calendarListPageSize) : undefined;
      return Response.json({ items: page.map(({ busy: _busy, freeBusyError: _error, ...item }) => item), ...(next ? { nextPageToken: next } : {}) });
    }

    if (method === 'POST' && path === '/freeBusy') {
      const request = body as { timeMin: string; timeMax: string; items: { id: string }[] };
      if (request.items.length > 50) return Response.json({ error: { code: 400, errors: [{ reason: 'tooManyCalendarsRequested' }] } }, { status: 400 });
      const [min, max] = [Date.parse(request.timeMin), Date.parse(request.timeMax)];
      const result: Record<string, unknown> = {};
      for (const { id } of request.items) {
        const calendar = calendars.find((c) => c.id === id);
        if (!calendar) result[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
        else if (calendar.freeBusyError) result[id] = { errors: [{ domain: 'global', reason: calendar.freeBusyError }], busy: [] };
        else {
          const created = [...this.events.values()].filter((e) => e.calendarId === id && !e.deleted).map(({ start, end }) => ({ start, end }));
          const busy = [...(calendar.busy ?? []), ...created].filter((b) => Date.parse(b.start) < max && Date.parse(b.end) > min);
          result[id] = { busy };
        }
      }
      return Response.json({ kind: 'calendar#freeBusy', timeMin: request.timeMin, timeMax: request.timeMax, calendars: result });
    }

    const eventsPath = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (eventsPath) {
      const calendarId = decodeURIComponent(eventsPath[1] ?? '');
      const calendar = calendars.find((c) => c.id === calendarId);
      if (!calendar) return Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });

      if (method === 'POST' && !eventsPath[2]) {
        if (calendar.accessRole !== 'owner') {
          return Response.json({ error: { code: 403, errors: [{ reason: 'requiredAccessLevel' }] } }, { status: 403 });
        }
        const event = body as { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string }; attendees: { email: string; displayName?: string }[] };
        if (this.events.has(event.id)) return Response.json({ error: { code: 409, errors: [{ reason: 'duplicate' }] } }, { status: 409 });
        this.events.set(event.id, {
          id: event.id,
          calendarId,
          summary: event.summary,
          start: event.start.dateTime,
          end: event.end.dateTime,
          attendees: event.attendees,
          sendUpdates: searchParams.get('sendUpdates'),
          deleted: false,
        });
        return Response.json({ id: event.id, status: 'confirmed' });
      }

      if (method === 'PATCH' && eventsPath[2]) {
        const event = this.events.get(decodeURIComponent(eventsPath[2]));
        if (!event || event.calendarId !== calendarId) return Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });
        if (event.deleted) return Response.json({ error: { code: 410, errors: [{ reason: 'deleted' }] } }, { status: 410 });
        const patch = body as { start?: { dateTime: string }; end?: { dateTime: string } };
        if (patch.start) event.start = patch.start.dateTime;
        if (patch.end) event.end = patch.end.dateTime;
        event.sendUpdates = searchParams.get('sendUpdates');
        return Response.json({ id: event.id, status: 'confirmed' });
      }

      if (method === 'DELETE' && eventsPath[2]) {
        const event = this.events.get(decodeURIComponent(eventsPath[2]));
        if (!event || event.calendarId !== calendarId) return Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });
        if (event.deleted) return Response.json({ error: { code: 410, errors: [{ reason: 'deleted' }] } }, { status: 410 });
        event.deleted = true;
        event.sendUpdates = searchParams.get('sendUpdates');
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });
  }

  async #idToken(account: FakeAccount, nonce: string): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims: JWTPayload = {
      iss: 'https://accounts.google.com',
      aud: TEST_GOOGLE_CONFIG.clientId,
      sub: account.sub,
      email: account.email,
      email_verified: account.emailVerified ?? true,
      ...(account.name ? { name: account.name } : {}),
      nonce,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      ...this.nextIdTokenClaims,
    };
    this.nextIdTokenClaims = null;
    const key = this.signNextWithUnknownKey ? this.#otherKey : this.#privateKey;
    this.signNextWithUnknownKey = false;
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fake-key-1' }).sign(key);
  }
}

// Resolves after `ms`, or rejects as fetch does when the signal aborts first.
function waitOrAbort(ms: number, signal: AbortSignal | null | undefined, until?: Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => void (until ?? Promise.resolve()).finally(resolve), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
