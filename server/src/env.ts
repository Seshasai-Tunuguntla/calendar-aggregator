// Settings the API can't run without. Checked when a server or function instance starts, so a
// missing one fails loudly at once instead of on the first request that needs it.
const REQUIRED = ['DATABASE_URL'] as const;
// Google sign-in is optional in development (the demo works without it) but required in
// production, where real hosts sign in.
const REQUIRED_IN_PRODUCTION = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_ORIGIN', 'COOKIE_SIGNING_SECRET', 'TOKEN_ENCRYPTION_KEYS'] as const;

type Env = Record<string, string | undefined>;

export function missingEnv(env: Env = process.env): string[] {
  const required = isProduction(env) ? [...REQUIRED, ...REQUIRED_IN_PRODUCTION] : REQUIRED;
  return required.filter((name) => !env[name]);
}

// Session cookies are Secure (HTTPS only) and get the __Host- prefix everywhere except local
// development and tests, which run over plain http://localhost.
export function isProduction(env: Env = process.env): boolean {
  return env['NODE_ENV'] === 'production';
}

// Vercel preview deployments must never touch the production database. The database settings are
// scoped to Production only in Vercel; this is the safety net in case they ever aren't: a preview
// runs no migrations and serves no API unless PREVIEW_HAS_OWN_DATABASE is true, which should only
// be set together with a separate preview database (a Neon branch).
export function isPreviewWithoutOwnDatabase(env: Env = process.env): boolean {
  return env['VERCEL_ENV'] === 'preview' && env['PREVIEW_HAS_OWN_DATABASE'] !== 'true';
}
