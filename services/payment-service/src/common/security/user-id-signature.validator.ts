import crypto from 'crypto';

/**
 * Validates X-User-Id-Sig header using HMAC-SHA256 with a minute-level time bucket.
 *
 * The signature is computed as: base64(HMAC-SHA256(key, userId + "|" + currentMinute))
 * This limits replay attacks to a 60-second window.
 *
 * If signingKey is not configured/empty, validation is skipped for graceful degradation during rollout.
 */
export class UserIdSignatureValidator {
  constructor(private readonly signingKey: string) {}

  /**
   * Validates the X-User-Id-Sig header against the provided userId.
   *
   * Returns true if:
   *   - Signing key is not configured (graceful degradation), OR
   *   - Signature is present and matches the current or previous minute bucket
   *
   * Returns false if:
   *   - Signing key is configured but signature is missing, OR
   *   - Signature is present but invalid
   */
  isValidSignature(userId: string | undefined, signature: string | undefined): boolean {
    if (!this.signingKey || this.signingKey.trim() === '') {
      return true;
    }

    if (!signature || signature.trim() === '') {
      return false;
    }

    if (!userId || userId.trim() === '') {
      return false;
    }

    try {
      const currentTimeSeconds = Math.floor(Date.now() / 1000);
      const currentMinute = Math.floor(currentTimeSeconds / 60);

      const expectedCurrent = this.computeSignature(userId, currentMinute);
      if (expectedCurrent === signature) {
        return true;
      }

      const expectedPrevious = this.computeSignature(userId, currentMinute - 1);
      if (expectedPrevious === signature) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private computeSignature(userId: string, minute: number): string {
    const message = `${userId}|${minute}`;
    const hmac = crypto.createHmac('sha256', this.signingKey);
    hmac.update(message);
    return hmac.digest('base64');
  }
}
