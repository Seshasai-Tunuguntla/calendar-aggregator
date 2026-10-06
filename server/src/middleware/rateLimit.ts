import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { ApiError } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { PostgresStore } from './rateLimitStore.ts';

// How many proxies in front of the app to trust for the client's address (app.set('trust proxy')).
// On Vercel there is exactly one: its edge, which overwrites X-Forwarded-For with the visitor's
// own address, so a visitor can't put a fake address there. With one trusted hop, Express takes
// the last X-Forwarded-For entry, the one that edge wrote, as req.ip.
export const TRUST_PROXY_HOPS = 1;

// Who a request counts against: the client's address. IPv6 addresses are grouped by /56 subnet,
// because one person often controls a whole subnet and could otherwise get a fresh allowance per
// address.
export function clientKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export interface RateLimitOptions {
  windowMs?: number;
  /** The error shown when the limit is reached. */
  message?: string;
  /** Count only requests that succeed (a 4xx or 5xx gives its hit back). */
  countSuccessesOnly?: boolean;
  /** Requests this returns true for aren't counted or limited. */
  skip?: (req: Request, res: Response) => boolean;
}

// `name` keeps each limiter's counts apart in the shared RateLimit table.
export function createRateLimiter({
  db,
  name,
  limit,
  windowMs = FIFTEEN_MINUTES,
  message = 'Too many requests, please try again later',
  countSuccessesOnly = false,
  skip,
}: { db: Db; name: string; limit: number } & RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: clientKey,
    store: new PostgresStore({ db, prefix: `${name}:` }),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: message } satisfies ApiError,
    skipFailedRequests: countSuccessesOnly,
    ...(skip ? { skip } : {}),
  });
}
