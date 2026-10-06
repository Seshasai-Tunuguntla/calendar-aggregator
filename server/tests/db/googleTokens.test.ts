import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { CalendarProviderError } from '../../src/calendar/provider.ts';
import { decryptToken, parseKeyring } from '../../src/auth/tokenCrypto.ts';
import { createGoogleOAuthClient } from '../../src/google/oauthClient.ts';
import { reencryptTokens } from '../../src/google/reencrypt.ts';
import { GoogleTokens, REFRESH_MARGIN_MS, tokenContext } from '../../src/google/tokens.ts';
import { TestBrowser } from '../helpers/browser.ts';
import { useTestDatabase } from '../helpers/db.ts';
import { FakeGoogle, TEST_GOOGLE_CONFIG } from '../helpers/fakeGoogle.ts';

const db = useTestDatabase();
const ACCOUNT = { sub: '3000000000000000001', email: 'host@gmail.com', name: 'Host' };

let google: FakeGoogle;
let clock: Date;
let tokens: GoogleTokens;
let connectionId: string;

// A real connection made through the sign-in flow, so the stored tokens are exactly what
// production stores.
beforeEach(async () => {
  google = await FakeGoogle.create();
  clock = new Date();
  const app = createApp({ db, production: false, rateLimits: false, now: () => clock, google: { config: TEST_GOOGLE_CONFIG, fetch: google.fetch, jwks: google.jwks } });
  const browser = new TestBrowser(app);
  const start = await browser.get('/api/auth/google/start');
  await browser.get(`/api/auth/google/callback?${new URLSearchParams(google.approve(start.headers['location'] as string, ACCOUNT))}`);
  connectionId = (await db.calendarConnection.findFirstOrThrow()).id;
  tokens = new GoogleTokens({ db, oauth: createGoogleOAuthClient(TEST_GOOGLE_CONFIG, google.fetch), keyring: TEST_GOOGLE_CONFIG.keyring, now: () => clock });
  google.requests.length = 0;
});

const connection = () => db.calendarConnection.findUniqueOrThrow({ where: { id: connectionId } });
const minutes = (n: number) => n * 60 * 1000;

describe('GoogleTokens.accessToken', () => {
  it('returns the stored access token without calling Google while more than 5 minutes are left', async () => {
    const stored = await connection();
    clock = new Date((stored.accessTokenExpiresAt?.getTime() ?? 0) - REFRESH_MARGIN_MS - 1);
    const token = await tokens.accessToken(connectionId);
    expect(token).toMatch(/^access-/);
    expect(google.requests).toHaveLength(0);
  });

  it('refreshes before expiry (5 minutes left) and stores the new token, encrypted', async () => {
    const before = await connection();
    clock = new Date((before.accessTokenExpiresAt?.getTime() ?? 0) - REFRESH_MARGIN_MS);
    const token = await tokens.accessToken(connectionId);

    expect(google.requests.map((r) => r.form['grant_type'])).toEqual(['refresh_token']);
    const after = await connection();
    expect(after.encryptedAccessToken).not.toBe(before.encryptedAccessToken);
    expect(decryptToken(after.encryptedAccessToken ?? '', 1, TEST_GOOGLE_CONFIG.keyring, tokenContext(ACCOUNT.sub, 'access'))).toBe(token);
    expect(after.accessTokenExpiresAt?.getTime()).toBe(clock.getTime() + 3599 * 1000);
    // The refresh token is kept (Google didn't send a new one).
    expect(decryptToken(after.encryptedRefreshToken ?? '', 1, TEST_GOOGLE_CONFIG.keyring, tokenContext(ACCOUNT.sub, 'refresh'))).toBe(google.refreshTokensIssued[0]);
    // And the next call uses the refreshed token without calling Google again.
    expect(await tokens.accessToken(connectionId)).toBe(token);
    expect(google.requests).toHaveLength(1);
  });

  it('stores a rotated refresh token, so the next refresh uses the new one', async () => {
    google.rotateRefreshTokens = true;
    clock = new Date(clock.getTime() + minutes(60));
    await tokens.accessToken(connectionId);
    const rotated = google.refreshTokensIssued[1];
    expect(rotated).toBeDefined();
    expect(decryptToken((await connection()).encryptedRefreshToken ?? '', 1, TEST_GOOGLE_CONFIG.keyring, tokenContext(ACCOUNT.sub, 'refresh'))).toBe(rotated);
    // The old one is now dead at Google; refreshing again still works because the new one is used.
    clock = new Date(clock.getTime() + minutes(60));
    await expect(tokens.accessToken(connectionId)).resolves.toMatch(/^access-/);
    expect(await connection()).toMatchObject({ status: 'ACTIVE' });
  });

  it('marks the connection NEEDS_RECONNECT on invalid_grant, deletes the dead tokens, and stops calling Google', async () => {
    google.revokeAll(ACCOUNT.sub);
    clock = new Date(clock.getTime() + minutes(60));
    const error = await tokens.accessToken(connectionId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarProviderError);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(await connection()).toMatchObject({ status: 'NEEDS_RECONNECT', encryptedRefreshToken: null, encryptedAccessToken: null, tokenKeyVersion: null });

    await expect(tokens.accessToken(connectionId)).rejects.toMatchObject({ kind: 'auth' });
    expect(google.requests).toHaveLength(1);
  });

  it("treats a network failure as temporary: 'unavailable', and the connection stays ACTIVE", async () => {
    clock = new Date(clock.getTime() + minutes(60));
    google.failNext = 'network';
    await expect(tokens.accessToken(connectionId)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await connection()).toMatchObject({ status: 'ACTIVE' });
    // The next try works.
    expect(await tokens.accessToken(connectionId)).toMatch(/^access-/);
  });

  it('marks a connection with no refresh token as needing reconnecting once its access token runs out', async () => {
    await db.calendarConnection.update({ where: { id: connectionId }, data: { encryptedRefreshToken: null } });
    clock = new Date(clock.getTime() + minutes(60));
    await expect(tokens.accessToken(connectionId)).rejects.toMatchObject({ kind: 'auth' });
    expect(await connection()).toMatchObject({ status: 'NEEDS_RECONNECT' });
  });
});

describe('reencryptTokens (key rotation)', () => {
  it('moves every token to the new key, after which the old key can be removed', async () => {
    const before = await connection();
    const oldKey = Buffer.from(TEST_GOOGLE_CONFIG.keyring.keys.get(1) ?? []).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const rotated = parseKeyring(`2:${newKey},1:${oldKey}`);

    expect(await reencryptTokens(db, rotated)).toEqual({ updated: 1, skipped: 0 });
    const after = await connection();
    expect(after.tokenKeyVersion).toBe(2);

    // Only the new key is needed now, and the tokens are unchanged.
    const newOnly = parseKeyring(`2:${newKey}`);
    const read = (ciphertext: string | null, version: number, keyring: typeof newOnly, kind: 'access' | 'refresh') =>
      decryptToken(ciphertext ?? '', version, keyring, tokenContext(ACCOUNT.sub, kind));
    expect(read(after.encryptedRefreshToken, 2, newOnly, 'refresh')).toBe(read(before.encryptedRefreshToken, 1, TEST_GOOGLE_CONFIG.keyring, 'refresh'));
    expect(read(after.encryptedAccessToken, 2, newOnly, 'access')).toBe(read(before.encryptedAccessToken, 1, TEST_GOOGLE_CONFIG.keyring, 'access'));

    // Running it again changes nothing.
    expect(await reencryptTokens(db, rotated)).toEqual({ updated: 0, skipped: 0 });
  });
});
