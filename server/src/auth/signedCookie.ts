import { createHmac, timingSafeEqual } from 'node:crypto';

// A small, tamper-proof cookie value: "<base64url JSON>.<base64url HMAC-SHA256>". Used for the
// short-lived OAuth state cookie, so the server can trust what it reads back (state, PKCE
// verifier, nonce) without storing it anywhere. It's signed, not encrypted: the browser could
// read it, but it's httpOnly (page scripts can't) and every value in it is single-use.

export function signValue(payload: Record<string, unknown>, secret: Buffer, expiresAtMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: expiresAtMs }), 'utf8').toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

// The payload, or null if the value is malformed, the signature is wrong, or it has expired.
export function verifyValue(value: string | undefined, secret: Buffer, nowMs: number): Record<string, unknown> | null {
  if (!value) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return null;

  const expected = Buffer.from(hmac(body, secret), 'base64url');
  const given = Buffer.from(signature, 'base64url');
  // Constant-time comparison, so the response time doesn't reveal how much of a guess was right.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (typeof record['exp'] !== 'number' || record['exp'] <= nowMs) return null;
    return record;
  } catch {
    return null;
  }
}

function hmac(body: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}
