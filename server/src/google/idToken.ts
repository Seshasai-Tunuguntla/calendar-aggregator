import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { GOOGLE_ENDPOINTS, GOOGLE_ISSUERS } from './config.ts';

// Verifies Google's ID token before we trust who signed in. jose checks the RS256 signature
// against Google's published keys (fetched from the JWKS URL and cached), then:
// - iss: one of Google's two issuer strings;
// - aud: our client id, so a token Google issued to another app can't be used here;
// - exp (and iat/nbf): not expired, with 30 seconds of tolerance for clock differences.
// On top of that we check the nonce from this sign-in, and that Google has verified the email.

const claimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
  nonce: z.string().optional(),
});

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
  email: string;
  name: string | undefined;
}

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

export type IdTokenVerifier = (idToken: string, expectedNonce: string) => Promise<GoogleIdentity>;

export function createIdTokenVerifier({ clientId, jwks }: { clientId: string; jwks?: JWTVerifyGetKey }): IdTokenVerifier {
  const keys = jwks ?? createRemoteJWKSet(new URL(GOOGLE_ENDPOINTS.jwks));

  return async (idToken, expectedNonce) => {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch (error) {
      // jose's error codes say what failed (expired, wrong audience, bad signature...) without
      // including the token itself.
      const reason = error instanceof errors.JOSEError ? error.code : 'invalid';
      throw new IdTokenError(`ID token rejected: ${reason}`);
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw new IdTokenError('ID token is missing required claims');
    if (claims.data.nonce !== expectedNonce) throw new IdTokenError('ID token nonce does not match this sign-in');
    if (!claims.data.email_verified) throw new IdTokenError("Google hasn't verified this account's email");

    return { sub: claims.data.sub, email: claims.data.email.toLowerCase(), name: claims.data.name };
  };
}
