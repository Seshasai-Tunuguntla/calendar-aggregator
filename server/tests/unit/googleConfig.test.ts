import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { googleAuthConfigFromEnv } from '../../src/google/config.ts';
import { GoogleOAuthError, createGoogleOAuthClient } from '../../src/google/oauthClient.ts';

const complete = {
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'super-secret-value',
  APP_ORIGIN: 'http://localhost:5190',
  COOKIE_SIGNING_SECRET: randomBytes(32).toString('base64'),
  TOKEN_ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
};

describe('googleAuthConfigFromEnv', () => {
  it('is null (Google sign-in off) when nothing is set', () => {
    expect(googleAuthConfigFromEnv({})).toBeNull();
  });

  it('derives the redirect URI from APP_ORIGIN', () => {
    expect(googleAuthConfigFromEnv(complete)?.redirectUri).toBe('http://localhost:5190/api/auth/google/callback');
  });

  it('fails loudly when partly configured, naming what is missing and never a value', () => {
    expect(() => googleAuthConfigFromEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'super-secret-value' })).toThrow(
      'missing: APP_ORIGIN, COOKIE_SIGNING_SECRET, TOKEN_ENCRYPTION_KEYS',
    );
  });

  it('rejects an APP_ORIGIN that is not a bare origin, and a short cookie secret', () => {
    expect(() => googleAuthConfigFromEnv({ ...complete, APP_ORIGIN: 'localhost:5190' })).toThrow('APP_ORIGIN');
    expect(() => googleAuthConfigFromEnv({ ...complete, APP_ORIGIN: 'http://localhost:5190/' })).toThrow('just the origin');
    expect(() => googleAuthConfigFromEnv({ ...complete, COOKIE_SIGNING_SECRET: 'short' })).toThrow('at least 32');
  });
});

// Stand-ins for Google's token endpoint.
const answersInvalidGrant: typeof fetch = async () => Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 });
const networkFails: typeof fetch = async () => {
  throw new TypeError('connect ECONNREFUSED with refresh_token=1//secret in some message');
};
const answersIncomplete: typeof fetch = async () => Response.json({ access_token: 'x' });

describe('GoogleOAuthClient errors', () => {
  const config = { clientId: 'id', clientSecret: 'super-secret-value', redirectUri: 'http://localhost:5190/api/auth/google/callback' };

  it("carry Google's error code and status, never the request's secrets", async () => {
    const error = await createGoogleOAuthClient(config, answersInvalidGrant).exchangeCode('the-auth-code', 'the-verifier').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error).toMatchObject({ code: 'invalid_grant', status: 400, isInvalidGrant: true });
    for (const secret of ['super-secret-value', 'the-auth-code', 'the-verifier']) expect(String(error)).not.toContain(secret);
  });

  it('report a network failure without details', async () => {
    const error = await createGoogleOAuthClient(config, networkFails).refreshAccessToken('1//secret').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'network_error', status: 0 });
    expect(String(error)).not.toContain('1//secret');
  });

  it('reject a success response that is missing fields', async () => {
    await expect(createGoogleOAuthClient(config, answersIncomplete).exchangeCode('c', 'v')).rejects.toMatchObject({ code: 'unexpected_response' });
  });
});
