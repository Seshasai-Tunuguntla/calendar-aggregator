import { z } from 'zod';
import { GOOGLE_ENDPOINTS, REQUESTED_SCOPES, type GoogleAuthConfig } from './config.ts';

// The four OAuth calls we make to Google, with plain fetch (injected, so tests use a fake Google).
// Error messages carry Google's error code and HTTP status only: never the request body, which
// holds the client secret, the code, the verifier or a token.

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string(),
  id_token: z.string().min(1),
  token_type: z.literal('Bearer'),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  // Google may rotate the refresh token; usually it doesn't send one.
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

const errorResponseSchema = z.object({ error: z.string() });

// invalid_grant: the refresh token (or code) is expired or revoked, or the account changed. The
// only fix is signing in again. Anything else is treated as temporary.
export class GoogleOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`Google OAuth request failed: ${code} (HTTP ${status})`);
    this.name = 'GoogleOAuthError';
    this.code = code;
    this.status = status;
  }

  get isInvalidGrant(): boolean {
    return this.code === 'invalid_grant';
  }
}

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  nonce: string;
  /** 'consent' forces Google's consent screen, which is what makes it return a refresh token again. */
  prompt: 'select_account' | 'consent';
  loginHint?: string | undefined;
}

export type GoogleOAuthClient = ReturnType<typeof createGoogleOAuthClient>;

// Google's error code from an error response (e.g. invalid_grant), never the rest of the body.
function failure(status: number, body: unknown): GoogleOAuthError {
  const parsed = errorResponseSchema.safeParse(body);
  return new GoogleOAuthError(parsed.success ? parsed.data.error : 'unexpected_response', status);
}

export function createGoogleOAuthClient(config: Pick<GoogleAuthConfig, 'clientId' | 'clientSecret' | 'redirectUri'>, fetchFn: typeof fetch) {
  // `signal` lets a caller with a deadline (a Google Calendar call refreshing its token) stop the
  // request sooner than the 10-second default.
  async function postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleOAuthError('network_error', 0);
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  return {
    authorizationUrl({ state, codeChallenge, nonce, prompt, loginHint }: AuthorizationRequest): string {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: REQUESTED_SCOPES.join(' '),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // offline: also return a refresh token, so calendars can be read when the host isn't here.
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt,
      });
      if (loginHint) params.set('login_hint', loginHint);
      return `${GOOGLE_ENDPOINTS.authorization}?${params}`;
    },

    async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
      const { status, body } = await postForm(GOOGLE_ENDPOINTS.token, {
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      });
      if (status !== 200) throw failure(status, body);
      const parsed = tokenResponseSchema.safeParse(body);
      if (!parsed.success) throw new GoogleOAuthError('unexpected_response', status);
      return parsed.data;
    },

    async refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<RefreshResponse> {
      const { status, body } = await postForm(
        GOOGLE_ENDPOINTS.token,
        { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret },
        signal,
      );
      if (status !== 200) throw failure(status, body);
      const parsed = refreshResponseSchema.safeParse(body);
      if (!parsed.success) throw new GoogleOAuthError('unexpected_response', status);
      return parsed.data;
    },

    // Revoking a refresh token also revokes the access tokens issued from it. Google answers 400
    // invalid_token for a token that's already revoked or expired, which is what we wanted anyway.
    async revoke(token: string): Promise<void> {
      const { status, body } = await postForm(GOOGLE_ENDPOINTS.revocation, { token });
      if (status === 200) return;
      const error = failure(status, body);
      if (error.code === 'invalid_token') return;
      throw error;
    },
  };
}
