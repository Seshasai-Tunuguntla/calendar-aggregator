import type { Request, RequestHandler } from 'express';
import { parse as parseCookies } from 'cookie';
import type { Db } from '../db.ts';
import { findSessionUser, sessionCookie, type AuthenticatedUser } from '../auth/sessions.ts';
import { HttpError } from '../utils/httpError.ts';

// The signed-in user of a request, set by requireAuth. A WeakMap rather than a property on `req`,
// so it's fully typed without augmenting Express's types, and nothing outlives the request.
const users = new WeakMap<Request, AuthenticatedUser>();

export function sessionToken(req: Request, production: boolean): string | undefined {
  return parseCookies(req.headers.cookie ?? '')[sessionCookie(production).name];
}

export function requireAuth({ db, production, now }: { db: Db; production: boolean; now: () => Date }): RequestHandler {
  return async (req, _res, next) => {
    const token = sessionToken(req, production);
    const user = token ? await findSessionUser(db, token, now()) : null;
    if (!user) throw new HttpError(401, 'Not signed in');
    users.set(req, user);
    next();
  };
}

// For handlers behind requireAuth.
export function currentUser(req: Request): AuthenticatedUser {
  const user = users.get(req);
  if (!user) throw new HttpError(401, 'Not signed in');
  return user;
}
