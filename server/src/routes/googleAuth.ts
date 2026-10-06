import { Router, type Request, type RequestHandler, type Response } from 'express';
import { parse as parseCookies } from 'cookie';
import { z } from 'zod';
import { isValidTimeZone } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { findSessionUser, sessionToken, startSession } from '../auth/sessions.ts';
import { codeChallengeS256, randomUrlSafe, safeEqual } from '../auth/pkce.ts';
import { signValue, verifyValue } from '../auth/signedCookie.ts';
import { CALENDAR_SCOPES, type GoogleAuthConfig } from '../google/config.ts';
import { connectGoogleAccount, signInWithGoogle } from '../google/accounts.ts';
import type { CalendarProvider } from '../calendar/provider.ts';
import { syncCalendars } from '../calendar/syncCalendars.ts';
import type { IdTokenVerifier } from '../google/idToken.ts';
import type { GoogleOAuthClient } from '../google/oauthClient.ts';
import { decryptRefreshToken, encryptedTokenFields } from '../google/tokens.ts';

// Google sign-in (and "connect another Google account"): the OAuth 2.0 authorization code flow
// with PKCE, plus OpenID Connect for identity. docs/PLAN.md ("Phase 4 decisions") walks through
// it; the comments below say what each step protects against.

const FLOW_TTL_MS = 10 * 60 * 1000;

// What travels from /start to /callback in the signed, httpOnly cookie.
const flowSchema = z.object({
  state: z.string(),
  verifier: z.string(),
  nonce: z.string(),
  intent: z.enum(['signin', 'connect']),
  userId: z.string().nullable(),
  timeZone: z.string(),
  forcedConsent: z.boolean(),
});
type Flow = z.infer<typeof flowSchema>;

const startQuerySchema = z.object({
  intent: z.enum(['signin', 'connect']).default('signin'),
  // The browser's time zone, for a new account's working hours. Must be a real IANA zone
  // (isValidTimeZone, below); anything else, including a fixed offset, falls back to UTC.
  tz: z.string().optional(),
  // Ask Google for its consent screen again (needed to get a new refresh token).
  consent: z.literal('1').optional(),
  // Preselects the account on Google's screen, e.g. when reconnecting it.
  hint: z.email().optional(),
});

const callbackQuerySchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

export interface GoogleAuthDeps {
  config: GoogleAuthConfig;
  oauth: GoogleOAuthClient;
  verifyIdToken: IdTokenVerifier;
  calendarProvider: CalendarProvider;
}

export function googleAuthRouter({
  db,
  google,
  production,
  now,
  callbackLimiter,
}: {
  db: Db;
  google: GoogleAuthDeps | null;
  production: boolean;
  now: () => Date;
  callbackLimiter: RequestHandler;
}): Router {
  const router = Router();
  const flowCookie = {
    name: production ? '__Host-google-oauth' : 'google-oauth',
    // Lax, not Strict: the callback is a top-level navigation from accounts.google.com, and
    // Strict cookies aren't sent on cross-site navigations.
    options: { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' },
  };

  router.get('/start', async (req, res) => {
    if (!google) {
      res.status(503).json({ error: "Google sign-in isn't set up on this server" });
      return;
    }
    const { config, oauth } = google;
    const query = startQuerySchema.parse(req.query);

    let userId: string | null = null;
    if (query.intent === 'connect') {
      const user = await signedInUser(db, req, production, now());
      if (!user) return redirectWithError(res, config, 'signin', 'signin_required');
      // Demo accounts use the demo calendar provider and must never hold real Google tokens.
      if (user.isDemo) return redirectWithError(res, config, 'connect', 'demo_cannot_connect');
      userId = user.id;
    }

    const flow: Flow = {
      state: randomUrlSafe(),
      verifier: randomUrlSafe(),
      nonce: randomUrlSafe(),
      intent: query.intent,
      userId,
      timeZone: query.tz && isValidTimeZone(query.tz) ? query.tz : 'UTC',
      forcedConsent: query.consent === '1',
    };
    res.cookie(flowCookie.name, signValue(flow, config.cookieSecret, now().getTime() + FLOW_TTL_MS), {
      ...flowCookie.options,
      maxAge: FLOW_TTL_MS,
    });
    res.redirect(
      302,
      oauth.authorizationUrl({
        state: flow.state,
        codeChallenge: codeChallengeS256(flow.verifier),
        nonce: flow.nonce,
        prompt: flow.forcedConsent ? 'consent' : 'select_account',
        loginHint: query.hint,
      }),
    );
  });

  router.get('/callback', callbackLimiter, async (req, res) => {
    if (!google) {
      res.status(503).json({ error: "Google sign-in isn't set up on this server" });
      return;
    }
    const { config, oauth, verifyIdToken, calendarProvider } = google;

    // 1. The flow cookie: signed by us, unexpired, and used once (cleared straight away).
    const rawFlow = verifyValue(parseCookies(req.headers.cookie ?? '')[flowCookie.name], config.cookieSecret, now().getTime());
    res.clearCookie(flowCookie.name, flowCookie.options);
    const flowParse = flowSchema.safeParse(rawFlow);
    if (!flowParse.success) return redirectWithError(res, config, 'signin', 'expired');
    const flow = flowParse.data;
    const fail = (code: string) => redirectWithError(res, config, flow.intent, code);

    // 2. state must match the one this browser was given. Without this check, an attacker could
    //    send someone a callback link with the attacker's own code and sign them into the
    //    attacker's account (login CSRF).
    const params = callbackQuerySchema.parse(req.query);
    if (!params.state || !safeEqual(params.state, flow.state)) return fail('state_mismatch');
    if (params.error) return fail(params.error === 'access_denied' ? 'access_denied' : 'google_error');
    if (!params.code) return fail('google_error');

    try {
      // 3. Swap the code for tokens, proving with the PKCE verifier that we started this flow.
      const tokens = await oauth.exchangeCode(params.code, flow.verifier);

      // 4. Verify the ID token (signature, issuer, audience, expiry, nonce) before trusting it.
      const identity = await verifyIdToken(tokens.id_token, flow.nonce);

      // 5. Google lets people untick scopes. Without calendar access the app can't work, so the
      //    partial grant is revoked (we keep no tokens we can't use) and the user is told why.
      const granted = tokens.scope.split(' ').filter(Boolean);
      if (CALENDAR_SCOPES.some((scope) => !granted.includes(scope))) {
        await oauth.revoke(tokens.refresh_token ?? tokens.access_token).catch(() => {});
        return fail('calendar_permission_missing');
      }

      // 6. Google returns a refresh token only the first time someone consents. Without a new one,
      //    keep the stored one if it still works; otherwise ask again with prompt=consent, once.
      const existing = await db.calendarConnection.findUnique({
        where: { provider_externalAccountId: { provider: 'GOOGLE', externalAccountId: identity.sub } },
      });
      let refreshToken = tokens.refresh_token ?? null;
      if (!refreshToken && existing?.status === 'ACTIVE') {
        try {
          refreshToken = decryptRefreshToken(existing, config.keyring);
        } catch {
          refreshToken = null;
        }
      }
      if (!refreshToken) {
        if (flow.forcedConsent) return fail('no_refresh_token');
        const retry = new URLSearchParams({ intent: flow.intent, tz: flow.timeZone, consent: '1', hint: identity.email });
        res.redirect(303, `/api/auth/google/start?${retry}`);
        return;
      }

      const update = {
        ...encryptedTokenFields({
          keyring: config.keyring,
          externalAccountId: identity.sub,
          accessToken: tokens.access_token,
          expiresInSeconds: tokens.expires_in,
          refreshToken,
          now: now(),
        }),
        grantedScopes: granted,
      };

      // 8 (after saving). Copy the account's calendar list, so the host can pick which count as
      // busy. Best effort: if Google's list fails right now, signing in still works and the
      // calendars page can sync again.
      const syncAccountCalendars = async () => {
        const connection = await db.calendarConnection.findUnique({
          where: { provider_externalAccountId: { provider: 'GOOGLE', externalAccountId: identity.sub } },
        });
        if (!connection) return;
        try {
          await syncCalendars(db, calendarProvider, connection);
        } catch (error) {
          console.error('Syncing calendars after sign-in failed:', error instanceof Error ? error.message : error);
        }
      };

      // 7. Save, then sign in (a brand-new session token) or go back to the calendars page.
      if (flow.intent === 'signin') {
        const result = await signInWithGoogle(db, { identity, update, timeZone: flow.timeZone });
        if ('error' in result) return fail(result.error);
        await syncAccountCalendars();
        await startSession({ db, req, res, production, userId: result.userId, now: now() });
        res.redirect(303, `${config.appOrigin}/dashboard`);
        return;
      }

      // Connecting: the browser must still be signed in as the user who started it.
      const user = await signedInUser(db, req, production, now());
      if (!user || user.id !== flow.userId) return fail('signin_required');
      const result = await connectGoogleAccount(db, { userId: user.id, identity, update });
      if ('error' in result) return fail(result.error);
      await syncAccountCalendars();
      res.redirect(303, `${config.appOrigin}/calendars?connected=1`);
    } catch (error) {
      // Google errors, a rejected ID token, or the database: the person gets a page they can act
      // on, the log gets the error. Errors here never contain tokens (see oauthClient.ts).
      console.error('Google sign-in failed:', error instanceof Error ? error.message : error);
      fail('google_error');
    }
  });

  return router;
}

async function signedInUser(db: Db, req: Request, production: boolean, now: Date) {
  const token = sessionToken(req, production);
  return token ? findSessionUser(db, token, now) : null;
}

// Sign-in problems go back to the login page; connect problems to the calendars page. The code
// is a fixed word the client turns into a message (never text from Google).
function redirectWithError(res: Response, config: GoogleAuthConfig, intent: 'signin' | 'connect', code: string): void {
  const page = intent === 'connect' ? '/calendars' : '/login';
  res.redirect(303, `${config.appOrigin}${page}?error=${encodeURIComponent(code)}`);
}
