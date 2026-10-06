import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@calendar-aggregator/shared';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' } satisfies ApiError);
};

// The fields an error thrown by Express or its body parser may carry (see the http-errors package).
interface ErrorWithStatus {
  status?: unknown;
  expose?: unknown;
  type?: unknown;
  message?: unknown;
}

function asErrorWithStatus(err: unknown): ErrorWithStatus {
  return typeof err === 'object' && err !== null ? (err as ErrorWithStatus) : {};
}

// Express 5 forwards rejected promises from async handlers here automatically,
// so handlers can let Zod throw (or throw an HttpError) without try/catch.
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    const body: ApiError = { error: err.issues[0]?.message ?? 'Invalid request', details: err.issues };
    res.status(400).json(body);
    return;
  }

  const e = asErrorWithStatus(err);

  if (e.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' } satisfies ApiError);
    return;
  }

  // Errors that carry their own 4xx status and a client-safe message:
  // HttpError, and body-parser errors such as payload too large.
  if (e.expose === true && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(e.status).json({ error: String(e.message) } satisfies ApiError);
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' } satisfies ApiError);
};
