import type { RequestHandler } from 'express';
import { HttpError } from '../utils/httpError.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence in depth, on top of the SameSite=Lax session cookie: a state-changing request
// (anything but GET/HEAD/OPTIONS) must come from a page on our own origin.
//
// Browsers set Origin (and Sec-Fetch-Site) themselves, and page scripts can't change them, so a
// page on another site can't make its request look same-origin. Requests without either header
// come from non-browser clients (curl, Supertest); they're allowed, because CSRF needs a victim's
// browser to attach its cookies, which those clients don't have.
//
// "Same origin" means Origin's host equals the request's Host. That holds on every Vercel
// deployment URL and behind the Vite dev proxy, without a list of allowed origins to maintain.
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (hostOf(origin) !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
    next();
    return;
  }

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  next();
};

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    // Includes Origin: null (sandboxed iframes, some redirects): never same-origin.
    return null;
  }
}
