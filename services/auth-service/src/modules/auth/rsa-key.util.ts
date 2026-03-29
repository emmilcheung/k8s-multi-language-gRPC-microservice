/**
 * Parses the RSA_PRIVATE_KEY environment variable into a PEM string.
 *
 * The value may be:
 *   1. A raw PEM string with literal `\n` escape sequences (common when the
 *      key is set via a single-line env var in CI / Kubernetes secrets).
 *   2. A base64-encoded PEM string (alternative encoding for env var injection).
 *
 * Returns the key in PEM format with real newlines so that Node.js crypto
 * functions and jsonwebtoken can consume it directly.
 */
export function parseRsaPrivateKey(raw: string): string {
  if (raw.includes('-----BEGIN')) {
    // Replace literal \n sequences with real newlines
    return raw.replace(/\\n/g, '\n');
  }
  // Treat the value as base64-encoded PEM
  return Buffer.from(raw, 'base64').toString('utf-8');
}
