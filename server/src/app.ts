import express from 'express';
import helmet from 'helmet';
import type { HealthResponse } from '@calendar-aggregator/shared';
import { errorHandler, notFound } from './middleware/errorHandler.ts';

// The Express app, without listen(), so tests can drive it with Supertest and the Vercel function
// can wrap it. There is no CORS middleware on purpose: the browser only ever talks to the API on
// its own origin (Vite proxies /api in development, and one Vercel project serves both in
// production), which also keeps the session cookie first-party.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' } satisfies HealthResponse);
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
