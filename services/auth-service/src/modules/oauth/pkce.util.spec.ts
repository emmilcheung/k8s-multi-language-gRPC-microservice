import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { verifyPkceChallenge } from './pkce.util';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('verifyPkceChallenge', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('returns true for a matching S256 challenge', () => {
    expect(verifyPkceChallenge(verifier, s256(verifier), 'S256')).toBe(true);
  });

  it('returns false when method is not S256', () => {
    expect(verifyPkceChallenge(verifier, s256(verifier), 'plain')).toBe(false);
  });

  it('returns false when verifier does not match challenge', () => {
    expect(verifyPkceChallenge('wrong-verifier', s256(verifier), 'S256')).toBe(
      false,
    );
  });

  it('returns false for empty verifier', () => {
    expect(verifyPkceChallenge('', s256(verifier), 'S256')).toBe(false);
  });

  it('returns false for empty challenge', () => {
    expect(verifyPkceChallenge(verifier, '', 'S256')).toBe(false);
  });

  it('is resistant to length-extension — different-length strings are rejected', () => {
    // A challenge that is longer than the computed one but shares the same prefix
    // must be rejected; timingSafeEqual rejects unequal lengths before comparing.
    const computed = s256(verifier);
    expect(verifyPkceChallenge(verifier, computed + 'X', 'S256')).toBe(false);
  });
});
