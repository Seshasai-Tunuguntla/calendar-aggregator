import express, { type Express } from 'express';
import type { ApiError } from '@calendar-aggregator/shared';
import { createApp } from './app.ts';
import { createDb } from './db.ts';
import { isPreviewWithoutOwnDatabase, missingEnv } from './env.ts';
import { googleAuthConfigFromEnv } from './google/config.ts';

type Env = Record<string, string | undefined>;

// The API as one Vercel Function (api/index.ts). On a cold start it rebuilds the demo if it's due.
//
// Two cases answer 503 instead of serving the API:
// - a preview deployment without a database of its own: preview deployments must never reach the
//   production database (Vercel gives them no database settings, and this is the safety net in
//   case it ever does);
// - missing settings: the names are logged, never the values, and every request gets a plain
//   message instead of the function crashing on start.
export function createVercelApp(env: Env = process.env): Express {
  if (isPreviewWithoutOwnDatabase(env)) {
    return unavailable('This preview deployment has no database of its own, so its API is switched off.');
  }
  const missing = missingEnv(env);
  if (missing.length > 0) {
    console.error(`API not started; missing environment variable(s): ${missing.join(', ')}`);
    return unavailable('The API is not configured yet.');
  }
  const google = googleAuthConfigFromEnv(env);
  return createApp({
    db: createDb(env['DATABASE_URL'] ?? ''),
    google: google ? { config: google } : null,
    resetDemoOnColdStart: true,
    logClientIp: env['LOG_CLIENT_IP'] === 'true',
  });
}

function unavailable(message: string): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res) => {
    res.status(503).set('Cache-Control', 'no-store').json({ error: message } satisfies ApiError);
  });
  return app;
}
