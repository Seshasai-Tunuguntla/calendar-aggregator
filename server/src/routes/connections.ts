import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ConnectionsResponse, DisconnectResponse } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { currentUser } from '../middleware/auth.ts';
import { HttpError } from '../utils/httpError.ts';
import { decryptToken, type Keyring } from '../auth/tokenCrypto.ts';
import type { GoogleOAuthClient } from '../google/oauthClient.ts';
import { decryptRefreshToken, tokenContext } from '../google/tokens.ts';

const idParamSchema = z.object({ id: z.uuid('Connection not found') });

export function connectionsRouter({
  db,
  requireAuth,
  google,
}: {
  db: Db;
  requireAuth: RequestHandler;
  google: { oauth: GoogleOAuthClient; keyring: Keyring } | null;
}): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const connections = await db.calendarConnection.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, accountEmail: true, status: true, createdAt: true },
    });
    const googleCount = connections.filter((c) => c.provider === 'GOOGLE').length;
    res.json({
      connections: connections.map((c) => ({
        ...c,
        canDisconnect: c.provider === 'GOOGLE' && googleCount > 1,
        createdAt: c.createdAt.toISOString(),
      })),
    } satisfies ConnectionsResponse);
  });

  // Disconnect: revoke our access at Google, then delete the tokens and the connection (its
  // calendars go with it). A user's last Google account can't be disconnected: it's how they sign
  // in, and signing in again would create a new, empty account.
  router.delete('/:id', async (req, res) => {
    const user = currentUser(req);
    const parsed = idParamSchema.safeParse(req.params);
    // Another user's connection gets the same 404 as a missing one, so ids reveal nothing.
    const connection = parsed.success
      ? await db.calendarConnection.findFirst({ where: { id: parsed.data.id, userId: user.id } })
      : null;
    if (!connection) throw new HttpError(404, 'Connection not found');
    if (connection.provider !== 'GOOGLE') throw new HttpError(409, "The demo calendar can't be disconnected");

    const googleCount = await db.calendarConnection.count({ where: { userId: user.id, provider: 'GOOGLE' } });
    if (googleCount <= 1) {
      throw new HttpError(409, "This is the Google account you sign in with. Connect another account before disconnecting it.");
    }

    let revokedAtGoogle = false;
    if (google) {
      try {
        // Revoking the refresh token revokes its access tokens too; fall back to the access token.
        const token =
          decryptRefreshToken(connection, google.keyring) ??
          (connection.encryptedAccessToken && connection.tokenKeyVersion !== null
            ? decryptToken(connection.encryptedAccessToken, connection.tokenKeyVersion, google.keyring, tokenContext(connection.externalAccountId, 'access'))
            : null);
        if (token) {
          await google.oauth.revoke(token);
          revokedAtGoogle = true;
        }
      } catch (error) {
        // Google unreachable (or the token can't be decrypted): still delete our copy. The user
        // can also remove access at myaccount.google.com/permissions.
        console.error('Revoking Google access failed:', error instanceof Error ? error.message : error);
      }
    }

    await db.calendarConnection.delete({ where: { id: connection.id } });
    res.json({ revokedAtGoogle } satisfies DisconnectResponse);
  });

  return router;
}
