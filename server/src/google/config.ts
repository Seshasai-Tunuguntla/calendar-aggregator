import { parseKeyring, type Keyring } from '../auth/tokenCrypto.ts';

// Google's endpoints, from https://accounts.google.com/.well-known/openid-configuration (checked
// October 2026). Hard-coded rather than fetched at startup: they've been stable for years, and a
// cold start shouldn't depend on one more network request.
export const GOOGLE_ENDPOINTS = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revocation: 'https://oauth2.googleapis.com/revoke',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;

// Google's ID tokens use either form of the issuer.
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// The narrowest scopes that work; docs/google-setup.md explains each one.
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
] as const;
export const REQUESTED_SCOPES = ['openid', 'email', 'profile', ...CALENDAR_SCOPES];

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  /** e.g. http://localhost:5190; the redirect URI is this + /api/auth/google/callback. */
  appOrigin: string;
  redirectUri: string;
  /** Signs the short-lived OAuth state cookie. */
  cookieSecret: Buffer;
  /** Encrypts tokens at rest. */
  keyring: Keyring;
}

const NAMES = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_ORIGIN', 'COOKIE_SIGNING_SECRET', 'TOKEN_ENCRYPTION_KEYS'] as const;

// Null when Google sign-in isn't configured at all (local development without credentials: the
// demo still works and the Google routes answer 503). Partly configured is a mistake, and fails
// loudly at startup instead of on someone's first sign-in. Error messages name variables, never
// their values.
export function googleAuthConfigFromEnv(env: Record<string, string | undefined> = process.env): GoogleAuthConfig | null {
  const present = NAMES.filter((name) => env[name]);
  if (present.length === 0) return null;
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Google sign-in is partly configured; missing: ${missing.join(', ')}`);

  const appOrigin = env['APP_ORIGIN'] ?? '';
  let origin: string;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    throw new Error('APP_ORIGIN must be a URL like http://localhost:5190');
  }
  if (origin !== appOrigin) throw new Error(`APP_ORIGIN must be just the origin, e.g. ${origin}`);

  const cookieSecret = Buffer.from(env['COOKIE_SIGNING_SECRET'] ?? '', 'base64');
  if (cookieSecret.length < 32) throw new Error('COOKIE_SIGNING_SECRET must be at least 32 random bytes, base64-encoded');

  return {
    clientId: env['GOOGLE_CLIENT_ID'] ?? '',
    clientSecret: env['GOOGLE_CLIENT_SECRET'] ?? '',
    appOrigin,
    redirectUri: `${appOrigin}/api/auth/google/callback`,
    cookieSecret,
    keyring: parseKeyring(env['TOKEN_ENCRYPTION_KEYS'] ?? ''),
  };
}
