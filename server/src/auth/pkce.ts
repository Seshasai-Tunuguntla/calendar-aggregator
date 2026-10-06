import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Random, URL-safe values for one sign-in attempt:
// - state: ties Google's redirect back to the browser that started it (stops a forged callback,
//   i.e. CSRF on the OAuth flow);
// - code verifier (PKCE): only we know it, so a stolen authorization code is useless without it;
// - nonce (OpenID Connect): Google copies it into the ID token, so a token from another sign-in
//   can't be replayed into this one.
// 32 random bytes = 43 base64url characters, inside PKCE's 43-128 range.
export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// PKCE S256: base64url(SHA-256(verifier)), sent to Google up front; the verifier itself is only
// sent with the code exchange, from our server.
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Compares two secrets without leaking, through timing, how many leading characters matched.
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
