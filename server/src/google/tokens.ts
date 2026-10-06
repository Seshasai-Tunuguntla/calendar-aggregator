import type { CalendarConnection } from '@prisma/client';
import type { Db } from '../db.ts';
import { CalendarProviderError } from '../calendar/provider.ts';
import { decryptToken, encryptToken, type Keyring } from '../auth/tokenCrypto.ts';
import { GoogleOAuthError, type GoogleOAuthClient } from './oauthClient.ts';

// Access tokens last about an hour. Refresh when less than this is left, so a token never expires
// in the middle of a request (or a slow Google call).
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Each encrypted token is bound to its account and kind (see tokenCrypto.ts).
export function tokenContext(externalAccountId: string, kind: 'access' | 'refresh'): string {
  return `google:${externalAccountId}:${kind}`;
}

// The token columns for a connection, all encrypted with the current key (one key version per
// row, so the refresh token is re-encrypted too when it's kept from before).
export function encryptedTokenFields({
  keyring,
  externalAccountId,
  accessToken,
  expiresInSeconds,
  refreshToken,
  now,
}: {
  keyring: Keyring;
  externalAccountId: string;
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  now: Date;
}) {
  const access = encryptToken(accessToken, keyring, tokenContext(externalAccountId, 'access'));
  return {
    encryptedAccessToken: access.ciphertext,
    accessTokenExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    encryptedRefreshToken: refreshToken === null ? null : encryptToken(refreshToken, keyring, tokenContext(externalAccountId, 'refresh')).ciphertext,
    tokenKeyVersion: access.keyVersion,
  };
}

export function decryptRefreshToken(connection: CalendarConnection, keyring: Keyring): string | null {
  if (!connection.encryptedRefreshToken || connection.tokenKeyVersion === null) return null;
  return decryptToken(connection.encryptedRefreshToken, connection.tokenKeyVersion, keyring, tokenContext(connection.externalAccountId, 'refresh'));
}

export class GoogleTokens {
  readonly #db: Db;
  readonly #oauth: GoogleOAuthClient;
  readonly #keyring: Keyring;
  readonly #now: () => Date;

  constructor({ db, oauth, keyring, now }: { db: Db; oauth: GoogleOAuthClient; keyring: Keyring; now: () => Date }) {
    this.#db = db;
    this.#oauth = oauth;
    this.#keyring = keyring;
    this.#now = now;
  }

  // A usable access token for a Google connection, refreshed first if it's (nearly) expired, or
  // always with forceRefresh (when Google rejected the one we thought was valid).
  // Throws CalendarProviderError: 'auth' when the connection needs reconnecting (and marks it so),
  // 'unavailable' when Google can't be reached.
  async accessToken(connectionId: string, { forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<string> {
    const connection = await this.#db.calendarConnection.findUniqueOrThrow({ where: { id: connectionId } });
    if (connection.provider !== 'GOOGLE') throw new Error('Not a Google connection');
    if (connection.status === 'NEEDS_RECONNECT') throw new CalendarProviderError('auth', 'Google access needs reconnecting');

    const now = this.#now();
    const { encryptedAccessToken, accessTokenExpiresAt, tokenKeyVersion, externalAccountId } = connection;
    const fresh = accessTokenExpiresAt !== null && accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
    if (!forceRefresh && fresh && encryptedAccessToken && tokenKeyVersion !== null) {
      return decryptToken(encryptedAccessToken, tokenKeyVersion, this.#keyring, tokenContext(externalAccountId, 'access'));
    }

    const refreshToken = decryptRefreshToken(connection, this.#keyring);
    if (!refreshToken) {
      await this.markNeedsReconnect(connection.id);
      throw new CalendarProviderError('auth', 'No refresh token stored; Google access needs reconnecting');
    }

    let refreshed;
    try {
      refreshed = await this.#oauth.refreshAccessToken(refreshToken);
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.isInvalidGrant) {
        // Revoked by the user, expired (7 days in Google's Testing mode), or the password changed.
        await this.markNeedsReconnect(connection.id);
        throw new CalendarProviderError('auth', 'Google access was revoked or expired', { cause: error });
      }
      throw new CalendarProviderError('unavailable', "Couldn't refresh Google access", { cause: error });
    }

    await this.#db.calendarConnection.update({
      where: { id: connection.id },
      data: encryptedTokenFields({
        keyring: this.#keyring,
        externalAccountId,
        accessToken: refreshed.access_token,
        expiresInSeconds: refreshed.expires_in,
        refreshToken: refreshed.refresh_token ?? refreshToken,
        now,
      }),
    });
    return refreshed.access_token;
  }

  // The stored tokens are dead (or lack a scope), so they're deleted rather than kept; the host's
  // dashboard shows "Reconnect Google" and signing in again issues new ones.
  async markNeedsReconnect(connectionId: string): Promise<void> {
    await this.#db.calendarConnection.update({
      where: { id: connectionId },
      data: { status: 'NEEDS_RECONNECT', encryptedAccessToken: null, encryptedRefreshToken: null, accessTokenExpiresAt: null, tokenKeyVersion: null },
    });
  }
}
