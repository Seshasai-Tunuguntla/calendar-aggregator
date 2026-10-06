import type { Db } from '../db.ts';
import { decryptToken, encryptToken, type Keyring } from '../auth/tokenCrypto.ts';
import { tokenContext } from './tokens.ts';

// Key rotation, step 2. Step 1: put a new key first in TOKEN_ENCRYPTION_KEYS ("2:new,1:old") and
// deploy; new tokens use version 2 and old ones still decrypt. Step 2 (this): move every stored
// token to the current key. Step 3: remove the old key from TOKEN_ENCRYPTION_KEYS.
//
// Each row is updated only if its key version hasn't changed since it was read, so a token
// refreshed at the same moment (already written with the current key) is never overwritten.
export async function reencryptTokens(db: Db, keyring: Keyring): Promise<{ updated: number; skipped: number }> {
  const rows = await db.calendarConnection.findMany({
    where: { provider: 'GOOGLE', tokenKeyVersion: { not: null, notIn: [keyring.current] } },
  });

  let updated = 0;
  for (const row of rows) {
    const version = row.tokenKeyVersion;
    if (version === null) continue;
    const move = (ciphertext: string | null, kind: 'access' | 'refresh') => {
      if (ciphertext === null) return null;
      const context = tokenContext(row.externalAccountId, kind);
      return encryptToken(decryptToken(ciphertext, version, keyring, context), keyring, context).ciphertext;
    };
    const result = await db.calendarConnection.updateMany({
      where: { id: row.id, tokenKeyVersion: version },
      data: {
        encryptedAccessToken: move(row.encryptedAccessToken, 'access'),
        encryptedRefreshToken: move(row.encryptedRefreshToken, 'refresh'),
        tokenKeyVersion: keyring.current,
      },
    });
    updated += result.count;
  }
  return { updated, skipped: rows.length - updated };
}
