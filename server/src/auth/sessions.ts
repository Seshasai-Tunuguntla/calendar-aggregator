import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { parse as parseCookies } from 'cookie';
import type { Db } from '../db.ts';

// A fixed lifetime from sign-in, not extended by use: after 14 days the host signs in again.
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Session cookie settings. The CSRF reasoning is in docs/PLAN.md ("Phase 3 decisions"):
// - httpOnly: page scripts can't read the token, so an XSS bug can't send it elsewhere.
// - SameSite=Lax: browsers leave the cookie off cross-site POST/PUT/DELETE requests (the CSRF
//   case) but still send it on top-level navigations, which the redirect back from Google's
//   sign-in page is. Strict would make that redirect arrive logged out.
// - Secure + the __Host- prefix in production: HTTPS only, and the browser refuses the cookie
//   unless it has Path=/ and no Domain, so no subdomain can set or overwrite it. Local
//   development runs on plain http://localhost, where neither is possible.
export function sessionCookie(production: boolean): { name: string; options: CookieOptions } {
  return {
    name: production ? '__Host-session' : 'session',
    options: { httpOnly: true, secure: production, sameSite: 'lax', path: '/' },
  };
}

// 32 random bytes: unguessable. Only the SHA-256 hash is stored, so a leaked database (or a log of
// it) contains no working session tokens. A plain hash is enough: the token is random, not a
// password, so there's nothing for a slow hash to protect against.
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Db, userId: string, now: Date): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

// The session token the browser sent, if any.
export function sessionToken(req: Request, production: boolean): string | undefined {
  return parseCookies(req.headers.cookie ?? '')[sessionCookie(production).name];
}

// Signs a browser in. Every sign-in (demo or Google) goes through here, so all of them:
// - issue a brand-new random token, never the one the browser sent. A token planted in the
//   browser by an attacker (session fixation) therefore never becomes a signed-in session;
// - delete the session the browser had before, so it can't be used any more;
// - delete every expired session. Serverless instances have no reliable background timer, so
//   cleanup happens as people sign in (the expiresAt index keeps it cheap).
export async function startSession({
  db,
  req,
  res,
  production,
  userId,
  now,
}: {
  db: Db;
  req: Request;
  res: Response;
  production: boolean;
  userId: string;
  now: Date;
}): Promise<void> {
  const previous = sessionToken(req, production);
  if (previous) await deleteSession(db, previous);
  await db.session.deleteMany({ where: { expiresAt: { lte: now } } });

  const { token } = await createSession(db, userId, now);
  const cookie = sessionCookie(production);
  res.cookie(cookie.name, token, { ...cookie.options, maxAge: SESSION_TTL_MS });
}

export const sessionUserFields = { id: true, name: true, email: true, handle: true, timeZone: true, isDemo: true } as const;

// The user a session token belongs to, or null if it's unknown or expired. An expired session is
// deleted when it's seen; startSession removes the ones nobody comes back with.
export async function findSessionUser(db: Db, token: string, now: Date) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, expiresAt: true, user: { select: sessionUserFields } },
  });
  if (!session) return null;
  if (session.expiresAt <= now) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }
  return session.user;
}

export type AuthenticatedUser = NonNullable<Awaited<ReturnType<typeof findSessionUser>>>;

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
