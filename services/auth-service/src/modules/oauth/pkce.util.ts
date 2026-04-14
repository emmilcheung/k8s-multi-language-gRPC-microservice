import { createHash, timingSafeEqual } from 'crypto';

/**
 * Verify a PKCE S256 code challenge against the provided code_verifier.
 * Returns true only if the challenge method is S256 and the computed challenge
 * matches the stored one.
 */
export function verifyPkceChallenge(
  codeVerifier: string,
  storedChallenge: string,
  method: string,
): boolean {
  if (method !== 'S256') return false;
  if (!codeVerifier || !storedChallenge) return false;

  const computed = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== storedChallenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(storedChallenge));
}
