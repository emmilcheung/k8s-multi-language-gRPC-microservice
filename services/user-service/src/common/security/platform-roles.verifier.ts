import crypto from "crypto";

const PLATFORM_ROLES = new Set(["platform_admin", "platform_support"]);

// Platform roles arrive in X-User-Roles, which is only trustworthy together
// with X-User-Roles-Sig = HMAC(userId|roles|minute), as the gateway signs it.
// Unlike the user id check, roles never pass when no key is configured.
export class PlatformRolesVerifier {
  constructor(private readonly signingKey: string) {}

  verify(
    userId: string | undefined,
    rolesHeader: string | undefined,
    signature: string | undefined,
  ): string[] {
    if (!this.signingKey || !userId || !rolesHeader || !signature) return [];
    if (!this.hasValidSignature(userId, rolesHeader, signature)) return [];
    const roles = rolesHeader
      .split(",")
      .map((r) => r.trim())
      .filter((r) => PLATFORM_ROLES.has(r));
    return [...new Set(roles)];
  }

  private hasValidSignature(
    userId: string,
    roles: string,
    signature: string,
  ): boolean {
    const minute = Math.floor(Date.now() / 1000 / 60);
    return [minute, minute - 1].some((m) =>
      this.safeEquals(this.compute(userId, roles, m), signature),
    );
  }

  private compute(userId: string, roles: string, minute: number): string {
    return crypto
      .createHmac("sha256", this.signingKey)
      .update(`${userId}|${roles}|${minute}`)
      .digest("base64");
  }

  private safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  }
}
