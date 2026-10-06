import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeChallengeS256, randomUrlSafe, safeEqual } from '../../src/auth/pkce.ts';
import { signValue, verifyValue } from '../../src/auth/signedCookie.ts';
import { TokenDecryptionError, decryptToken, encryptToken, parseKeyring } from '../../src/auth/tokenCrypto.ts';

const key = () => randomBytes(32).toString('base64');

describe('tokenCrypto (AES-256-GCM)', () => {
  const keyring = parseKeyring(`1:${key()}`);
  const context = 'google:123:refresh';

  it('round-trips, and the ciphertext never contains the token', () => {
    const { ciphertext, keyVersion } = encryptToken('1//refresh-token-value', keyring, context);
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain('refresh-token-value');
    expect(ciphertext).toMatch(/^[\w-]{16}\.[\w-]+\.[\w-]{22}$/);
    expect(decryptToken(ciphertext, 1, keyring, context)).toBe('1//refresh-token-value');
  });

  it('uses a fresh IV each time, so the same token encrypts differently', () => {
    expect(encryptToken('same', keyring, context).ciphertext).not.toBe(encryptToken('same', keyring, context).ciphertext);
  });

  it('detects tampering', () => {
    const { ciphertext } = encryptToken('token', keyring, context);
    const [iv, body = '', tag] = ciphertext.split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decryptToken(`${iv}.${flipped.toString('base64url')}.${tag}`, 1, keyring, context)).toThrow(TokenDecryptionError);
  });

  it("won't decrypt a ciphertext moved to another account or field (bound to its context)", () => {
    const { ciphertext } = encryptToken('token', keyring, 'google:123:refresh');
    expect(() => decryptToken(ciphertext, 1, keyring, 'google:456:refresh')).toThrow('failed authentication');
    expect(() => decryptToken(ciphertext, 1, keyring, 'google:123:access')).toThrow('failed authentication');
  });

  it('rejects a wrong key, an unknown key version, and malformed input', () => {
    const { ciphertext } = encryptToken('token', keyring, context);
    expect(() => decryptToken(ciphertext, 1, parseKeyring(`1:${key()}`), context)).toThrow(TokenDecryptionError);
    expect(() => decryptToken(ciphertext, 2, keyring, context)).toThrow('No encryption key with version 2');
    expect(() => decryptToken('not.valid', 1, keyring, context)).toThrow('Malformed');
  });

  it('encrypts with the first key and decrypts with any (rotation)', () => {
    const oldKey = key();
    const old = parseKeyring(`1:${oldKey}`);
    const rotated = parseKeyring(`2:${key()},1:${oldKey}`);
    const before = encryptToken('token', old, context);
    expect(decryptToken(before.ciphertext, 1, rotated, context)).toBe('token');
    expect(encryptToken('token', rotated, context).keyVersion).toBe(2);
  });

  it('validates the keyring without ever echoing key material', () => {
    const shortKey = Buffer.alloc(16, 7).toString('base64');
    for (const [value, message] of [
      ['', 'no keys'],
      ['nonsense', 'must look like'],
      [`1:${shortKey}`, 'must be 32 bytes'],
      [`1:${key()},1:${key()}`, 'version 1 twice'],
    ] as const) {
      let error: unknown;
      try {
        parseKeyring(value);
      } catch (e) {
        error = e;
      }
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(shortKey);
    }
  });
});

describe('signedCookie', () => {
  const secret = randomBytes(32);
  const now = 1_800_000_000_000;

  it('round-trips a payload until it expires', () => {
    const value = signValue({ state: 'abc' }, secret, now + 1000);
    expect(verifyValue(value, secret, now)).toEqual({ state: 'abc', exp: now + 1000 });
    expect(verifyValue(value, secret, now + 1000)).toBeNull();
  });

  it('rejects a changed payload, a changed signature, another secret, and junk', () => {
    const value = signValue({ intent: 'signin' }, secret, now + 1000);
    const [body = '', signature = ''] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ intent: 'connect', exp: now + 1000 })).toString('base64url');
    expect(verifyValue(`${forged}.${signature}`, secret, now)).toBeNull();
    expect(verifyValue(`${body}.${signature.slice(0, -2)}AA`, secret, now)).toBeNull();
    expect(verifyValue(value, randomBytes(32), now)).toBeNull();
    for (const junk of [undefined, '', 'a', 'a.b.c', '.']) expect(verifyValue(junk, secret, now)).toBeNull();
  });

  it('rejects a correctly signed value that is not a JSON object with an expiry', () => {
    // Signed exactly as signValue signs, so only the payload check can reject these.
    const signed = (text: string) => {
      const body = Buffer.from(text).toString('base64url');
      return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
    };
    expect(verifyValue(signed(JSON.stringify({ state: 'abc', exp: now + 1000 })), secret, now)).toEqual({ state: 'abc', exp: now + 1000 });
    expect(verifyValue(signed('[1,2]'), secret, now)).toBeNull();
    expect(verifyValue(signed('{"state":"abc"}'), secret, now)).toBeNull();
    expect(verifyValue(signed('{"exp":"later"}'), secret, now)).toBeNull();
    expect(verifyValue(signed('not json'), secret, now)).toBeNull();
  });
});

describe('PKCE', () => {
  it('computes the S256 challenge from the RFC 7636 example', () => {
    // RFC 7636, Appendix B.
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes 43-character URL-safe random values (the PKCE minimum length)', () => {
    const value = randomUrlSafe();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomUrlSafe()).not.toBe(value);
  });

  it('compares secrets in constant time, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
