import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encryption at rest for OAuth tokens: AES-256-GCM with a versioned keyring.
//
// - GCM is authenticated: a modified ciphertext (or the wrong key) fails to decrypt instead of
//   producing garbage.
// - Every ciphertext is bound to a context string (e.g. "google:<sub>:refresh") as GCM's
//   additional authenticated data, so an encrypted token copied into another row or field fails to
//   decrypt there.
// - A fresh random 12-byte IV per encryption: GCM must never reuse an IV with the same key.
// - Keys are versioned. TOKEN_ENCRYPTION_KEYS="2:<new>,1:<old>": the first key encrypts, every key
//   decrypts, and each row stores the version it was encrypted with, so keys can be rotated
//   (scripts/reencryptTokens.ts moves every row to the current key, then the old one can go).

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface Keyring {
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

// "2:base64key,1:base64key" -> keyring. Throws with a message that never includes key material.
export function parseKeyring(value: string): Keyring {
  const keys = new Map<number, Buffer>();
  let current: number | undefined;
  for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = /^(\d+):(.+)$/.exec(entry);
    if (!match) throw new Error('TOKEN_ENCRYPTION_KEYS entries must look like "<version>:<base64 key>"');
    const version = Number(match[1]);
    const key = Buffer.from(match[2] ?? '', 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`TOKEN_ENCRYPTION_KEYS key version ${version} must be ${KEY_BYTES} bytes`);
    if (keys.has(version)) throw new Error(`TOKEN_ENCRYPTION_KEYS has key version ${version} twice`);
    keys.set(version, key);
    current ??= version;
  }
  if (current === undefined) throw new Error('TOKEN_ENCRYPTION_KEYS has no keys');
  return { current, keys };
}

export class TokenDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

// Encrypts with the current key. Output: "<iv>.<ciphertext>.<tag>", each base64url.
export function encryptToken(plaintext: string, keyring: Keyring, context: string): { ciphertext: string; keyVersion: number } {
  const key = keyring.keys.get(keyring.current);
  if (!key) throw new Error('Current encryption key is missing from the keyring');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url'));
  return { ciphertext: parts.join('.'), keyVersion: keyring.current };
}

export function decryptToken(ciphertext: string, keyVersion: number, keyring: Keyring, context: string): string {
  const key = keyring.keys.get(keyVersion);
  if (!key) throw new TokenDecryptionError(`No encryption key with version ${keyVersion}`);
  const [iv, encrypted, tag] = ciphertext.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !encrypted || !tag || iv.length !== IV_BYTES || tag.length !== 16) {
    throw new TokenDecryptionError('Malformed encrypted token');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong context or tampered data: GCM's tag check failed. No details on purpose.
    throw new TokenDecryptionError('Encrypted token failed authentication');
  }
}
