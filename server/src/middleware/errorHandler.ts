import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { ApiError } from '@calendar-aggregator/shared';
import { HttpError } from '../utils/httpError.ts';

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
// so handlers can let Zod/Prisma throw (or throw an HttpError) without try/catch.
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Our own errors: always a client-safe message, whatever the status (a 503 says "try again
  // later" when Google is down, for example).
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message } satisfies ApiError);
    return;
  }

  if (err instanceof ZodError) {
    const body: ApiError = { error: err.issues[0]?.message ?? 'Invalid request', details: err.issues };
    res.status(400).json(body);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // meta.target is usually an array of field names, but can be a constraint name string.
      const fields = ([] as unknown[]).concat(err.meta?.['target'] ?? []).join(', ');
      res.status(409).json({ error: `${fields || 'Value'} already in use` } satisfies ApiError);
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found' } satisfies ApiError);
      return;
    }
  }

  const e = asErrorWithStatus(err);

  if (e.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' } satisfies ApiError);
    return;
  }

  // Other errors that carry their own 4xx status and a client-safe message: body-parser errors
  // such as payload too large. A 5xx from elsewhere is never trusted to be safe.
  if (e.expose === true && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(e.status).json({ error: String(e.message) } satisfies ApiError);
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' } satisfies ApiError);
};
