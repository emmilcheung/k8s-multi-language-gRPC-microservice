import crypto from "crypto";

export class UserIdSignatureValidator {
  constructor(private readonly signingKey: string) {}

  isValidSignature(
    userId: string | undefined,
    signature: string | undefined,
  ): boolean {
    if (!this.signingKey || this.signingKey.trim() === "") {
      return true;
    }

    if (!signature || signature.trim() === "") {
      return false;
    }

    if (!userId || userId.trim() === "") {
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
    const hmac = crypto.createHmac("sha256", this.signingKey);
    hmac.update(message);
    return hmac.digest("base64");
  }
}
