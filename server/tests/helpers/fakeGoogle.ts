import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { parseKeyring } from '../../src/auth/tokenCrypto.ts';
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
  readonly #accessTokens = new Map<string, { revoked: boolean }>();
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

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    this.requests.push({ url, form });

    const failure = this.failNext;
    if (failure === 'network') {
      this.failNext = null;
      throw new TypeError('fetch failed');
    }
    const endpoint = url === GOOGLE_ENDPOINTS.token ? 'token' : url === GOOGLE_ENDPOINTS.revocation ? 'revoke' : null;
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

    const accessToken = this.#newAccessToken();
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
      access_token: this.#newAccessToken(),
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

  #newAccessToken(): string {
    const token = `access-${randomBytes(16).toString('hex')}`;
    this.#accessTokens.set(token, { revoked: false });
    return token;
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
