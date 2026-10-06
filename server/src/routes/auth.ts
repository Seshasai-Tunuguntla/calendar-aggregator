import { Router, type RequestHandler } from 'express';
import type { MeResponse } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { DEMO_IDS } from '../demo/demoData.ts';
import { ensureDemoHost } from '../demo/ensureDemoHost.ts';
import { deleteSession, sessionCookie, sessionToken, sessionUserFields, startSession } from '../auth/sessions.ts';
import { currentUser, requireAuth } from '../middleware/auth.ts';

export function authRouter({
  db,
  production,
  now,
  demoLoginLimiter,
}: {
  db: Db;
  production: boolean;
  now: () => Date;
  demoLoginLimiter: RequestHandler;
}): Router {
  const router = Router();
  const cookie = sessionCookie(production);

  // "Try as host": signs the visitor in as the demo host, creating them on first use.
  router.post('/demo', demoLoginLimiter, async (req, res) => {
    await ensureDemoHost(db, now());
    await startSession({ db, req, res, production, userId: DEMO_IDS.host, now: now() });
    const user = await db.user.findUniqueOrThrow({ where: { id: DEMO_IDS.host }, select: sessionUserFields });
    res.json({ user } satisfies MeResponse);
  });

  router.get('/me', requireAuth({ db, production, now }), (req, res) => {
    res.json({ user: currentUser(req) } satisfies MeResponse);
  });

  // Works with or without a valid session, so a stale cookie can always be cleared.
  router.post('/logout', async (req, res) => {
    const token = sessionToken(req, production);
    if (token) await deleteSession(db, token);
    res.clearCookie(cookie.name, cookie.options);
    res.status(204).end();
  });

  return router;
}
