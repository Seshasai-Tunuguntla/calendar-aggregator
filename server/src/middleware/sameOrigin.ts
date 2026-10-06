import type { RequestHandler } from 'express';
import { HttpError } from '../utils/httpError.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence in depth, on top of the SameSite=Lax session cookie: a state-changing request
// (anything but GET/HEAD/OPTIONS) must carry an Origin header naming our own origin, or it's
// rejected with 403.
//
// Browsers always send Origin on POST, PUT, PATCH and DELETE (the Fetch standard requires it, for
// same-origin requests too), and page scripts can't change it, so another site can't make its
// request look like ours. A request without Origin therefore isn't from our pages in a browser,
// so it's rejected as well. (curl and other scripts must send one; the tests do.)
//
// "Our origin" means Origin's host equals the request's Host. That holds on every Vercel
// deployment URL and behind the Vite dev proxy (which keeps Host), without an allow-list to
// maintain. Origin: null (sandboxed iframes, some redirects) never matches.
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin === undefined || hostOf(origin) !== req.headers.host) {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  next();
};

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
