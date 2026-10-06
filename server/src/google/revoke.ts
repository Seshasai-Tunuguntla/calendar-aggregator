import type { CalendarConnection } from '@prisma/client';
import { decryptToken, type Keyring } from '../auth/tokenCrypto.ts';
import type { GoogleOAuthClient } from './oauthClient.ts';
import { decryptRefreshToken, tokenContext } from './tokens.ts';

export interface GoogleRevoker {
  oauth: GoogleOAuthClient;
  keyring: Keyring;
}

// Revokes our access to a Google account (disconnect, account deletion). Revoking the refresh
// token revokes its access tokens too; without one, the access token is revoked. Returns false if
// Google couldn't be reached or there was no token to revoke: callers delete our copy anyway, and
// the user can also remove access at myaccount.google.com/permissions.
export async function revokeGoogleAccess(google: GoogleRevoker | null, connection: CalendarConnection): Promise<boolean> {
  if (!google) return false;
  try {
    const token =
      decryptRefreshToken(connection, google.keyring) ??
      (connection.encryptedAccessToken && connection.tokenKeyVersion !== null
        ? decryptToken(connection.encryptedAccessToken, connection.tokenKeyVersion, google.keyring, tokenContext(connection.externalAccountId, 'access'))
        : null);
    if (!token) return false;
    await google.oauth.revoke(token);
    return true;
  } catch (error) {
    console.error('Revoking Google access failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
