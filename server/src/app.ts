import express, { type RequestHandler } from 'express';
import helmet from 'helmet';
import type { JWTVerifyGetKey } from 'jose';
import type { HealthResponse } from '@calendar-aggregator/shared';
import type { Db } from './db.ts';
import { isProduction } from './env.ts';
import type { GoogleAuthConfig } from './google/config.ts';
import { createIdTokenVerifier } from './google/idToken.ts';
import { createGoogleOAuthClient } from './google/oauthClient.ts';
import { requireAuth } from './middleware/auth.ts';
import { errorHandler, notFound } from './middleware/errorHandler.ts';
import { TRUST_PROXY_HOPS, createRateLimiter } from './middleware/rateLimit.ts';
import { requireSameOrigin } from './middleware/sameOrigin.ts';
import { authRouter } from './routes/auth.ts';
import { connectionsRouter } from './routes/connections.ts';
import { googleAuthRouter } from './routes/googleAuth.ts';

export interface AppDeps {
  db: Db;
  /** Secure, __Host- cookies. Defaults to NODE_ENV === 'production'. */
  production?: boolean;
  /** The clock, injectable so tests can move time (session expiry). */
  now?: () => Date;
  /** Off in most tests, which make far more requests than the limits allow on purpose. */
  rateLimits?: boolean;
  /**
   * Google sign-in. Null when it isn't configured (the demo still works). Tests pass a fake
   * Google: their own fetch and signing keys.
   */
  google?: { config: GoogleAuthConfig; fetch?: typeof fetch; jwks?: JWTVerifyGetKey } | null;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

// The Express app, without listen(), so tests can drive it with Supertest and the Vercel function
// can wrap it. There is no CORS middleware on purpose: the browser only ever talks to the API on
// its own origin (Vite proxies /api in development, and one Vercel project serves both in
// production), which also keeps the session cookie first-party.
export function createApp({ db, production = isProduction(), now = () => new Date(), rateLimits = true, google = null }: AppDeps) {
  const app = express();

  // In production the API runs as a Vercel Function behind Vercel's edge, one proxy hop, so req.ip
  // (and the rate limiters' key) is the visitor's address.
  app.set('trust proxy', TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  // API responses can carry private data; no browser or shared cache should keep them.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', requireSameOrigin);

  const limiter = (name: string, limit: number) => (rateLimits ? createRateLimiter({ db, name, limit }) : passThrough);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' } satisfies HealthResponse);
  });

  const googleDeps = google
    ? {
        config: google.config,
        oauth: createGoogleOAuthClient(google.config, google.fetch ?? fetch),
        verifyIdToken: createIdTokenVerifier({ clientId: google.config.clientId, ...(google.jwks ? { jwks: google.jwks } : {}) }),
      }
    : null;
  const signedIn = requireAuth({ db, production, now });

  // Each demo login creates a session row: 30 per client per 15 minutes is plenty for a visitor
  // and stops a script from filling the table.
  app.use('/api/auth', authRouter({ db, production, now, demoLoginLimiter: limiter('demo-login', 30) }));
  // Each callback calls Google's token endpoint: the same allowance.
  app.use('/api/auth/google', googleAuthRouter({ db, google: googleDeps, production, now, callbackLimiter: limiter('google-callback', 30) }));
  app.use(
    '/api/connections',
    connectionsRouter({ db, requireAuth: signedIn, google: googleDeps && { oauth: googleDeps.oauth, keyring: googleDeps.config.keyring } }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
