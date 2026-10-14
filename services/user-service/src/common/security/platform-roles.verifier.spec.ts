import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { PlatformRolesVerifier } from "./platform-roles.verifier";

const KEY = "test-signing-key-1234";

function sign(userId: string, roles: string, minute: number, key = KEY) {
  return crypto
    .createHmac("sha256", key)
    .update(`${userId}|${roles}|${minute}`)
    .digest("base64");
}
const minuteNow = () => Math.floor(Date.now() / 1000 / 60);

describe("PlatformRolesVerifier", () => {
  const verifier = new PlatformRolesVerifier(KEY);

  it("keeps platform roles whose signature matches the user and the exact role list", () => {
    const header = "platform_admin,platform_support";
    expect(
      verifier.verify("u1", header, sign("u1", header, minuteNow())),
    ).toEqual(["platform_admin", "platform_support"]);
  });

  it("accepts a signature from the previous minute", () => {
    const header = "platform_admin";
    expect(
      verifier.verify("u1", header, sign("u1", header, minuteNow() - 1)),
    ).toEqual(["platform_admin"]);
  });

  it("grants nothing for an unsigned roles header", () => {
    expect(verifier.verify("u1", "platform_admin", undefined)).toEqual([]);
  });

  it("grants nothing when the roles were changed after signing", () => {
    const sig = sign("u1", "buyer", minuteNow());
    expect(verifier.verify("u1", "platform_admin", sig)).toEqual([]);
  });

  it("grants nothing when the signature belongs to another user", () => {
    const header = "platform_admin";
    expect(
      verifier.verify("u1", header, sign("u2", header, minuteNow())),
    ).toEqual([]);
  });

  it("grants nothing for a stale signature", () => {
    const header = "platform_admin";
    expect(
      verifier.verify("u1", header, sign("u1", header, minuteNow() - 5)),
    ).toEqual([]);
  });

  it("ignores roles that are not platform roles even when signed", () => {
    const header = "organizer,platform_support,admin";
    expect(
      verifier.verify("u1", header, sign("u1", header, minuteNow())),
    ).toEqual(["platform_support"]);
  });

  it("never trusts roles when no signing key is configured", () => {
    const open = new PlatformRolesVerifier("");
    expect(open.verify("u1", "platform_admin", "anything")).toEqual([]);
  });
});
