import { describe, expect, it } from 'vitest';
import { hashToken, newSessionToken, sessionCookie } from '../../src/auth/sessions.ts';
import { isPreviewWithoutOwnDatabase, isProduction, missingEnv } from '../../src/env.ts';

describe('sessionCookie', () => {
  it('in production is httpOnly, Secure, SameSite=Lax, Path=/ and uses the __Host- prefix', () => {
    expect(sessionCookie(true)).toEqual({
      name: '__Host-session',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    });
  });

  it('in local development drops Secure and the prefix (plain http://localhost can use neither)', () => {
    expect(sessionCookie(false)).toEqual({
      name: 'session',
      options: { httpOnly: true, secure: false, sameSite: 'lax', path: '/' },
    });
  });
});

describe('session tokens', () => {
  it('are 32 random bytes, base64url encoded, and different every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, newSessionToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as their SHA-256 hash', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('env', () => {
  it('lists missing required settings', () => {
    expect(missingEnv({})).toEqual(['DATABASE_URL']);
    expect(missingEnv({ DATABASE_URL: 'postgresql://x' })).toEqual([]);
  });

  it('is production only when NODE_ENV says so', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'test' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });

  it('treats a Vercel preview as database-less unless it says it has its own database', () => {
    expect(isPreviewWithoutOwnDatabase({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(isPreviewWithoutOwnDatabase({ VERCEL_ENV: 'preview', PREVIEW_HAS_OWN_DATABASE: 'true' })).toBe(false);
    expect(isPreviewWithoutOwnDatabase({ VERCEL_ENV: 'production' })).toBe(false);
  });
});
