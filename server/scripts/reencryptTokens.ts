// npm run tokens:reencrypt --workspace server
// Moves every stored Google token to the current key in TOKEN_ENCRYPTION_KEYS (see
// src/google/reencrypt.ts for the full rotation steps). Prints counts only, never tokens.
import { parseKeyring } from '../src/auth/tokenCrypto.ts';
import { createDb } from '../src/db.ts';
import { reencryptTokens } from '../src/google/reencrypt.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // Use the environment as it is.
}

const databaseUrl = process.env['DATABASE_URL'];
const keys = process.env['TOKEN_ENCRYPTION_KEYS'];
if (!databaseUrl || !keys) throw new Error('DATABASE_URL and TOKEN_ENCRYPTION_KEYS must be set');

const keyring = parseKeyring(keys);
const db = createDb(databaseUrl);
try {
  const { updated, skipped } = await reencryptTokens(db, keyring);
  console.info(`Re-encrypted ${updated} connection(s) with key version ${keyring.current}; ${skipped} changed meanwhile and already use it.`);
} finally {
  await db.$disconnect();
}
