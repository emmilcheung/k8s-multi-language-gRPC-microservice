import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { UserIdSignatureValidator } from "./user-id-signature.validator";

const TEST_KEY = "test-signing-key-1234";

function computeValidSignature(userId: string, key: string): string {
  const currentMinute = Math.floor(Date.now() / 1000 / 60);
  const message = `${userId}|${currentMinute}`;
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(message);
  return hmac.digest("base64");
}

describe("UserIdSignatureValidator", () => {
  it("accepts valid signature for current minute", () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    const userId = "user-123";
    const sig = computeValidSignature(userId, TEST_KEY);
    expect(validator.isValidSignature(userId, sig)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    expect(validator.isValidSignature("user-123", "invalid")).toBe(false);
  });

  it("rejects missing signature when key configured", () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    expect(validator.isValidSignature("user-123", undefined)).toBe(false);
  });

  it("rejects missing userId", () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    expect(validator.isValidSignature(undefined, "some-sig")).toBe(false);
  });

  it("skips validation when signing key is empty", () => {
    const validator = new UserIdSignatureValidator("");
    expect(validator.isValidSignature("user-123", undefined)).toBe(true);
  });

  it("rejects signature from wrong key", () => {
    const validator = new UserIdSignatureValidator(TEST_KEY);
    const sig = computeValidSignature("user-123", "wrong-key");
    expect(validator.isValidSignature("user-123", sig)).toBe(false);
  });
});
