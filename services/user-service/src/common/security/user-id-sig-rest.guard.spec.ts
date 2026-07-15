import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { UserIdSigRestGuard } from "./user-id-sig-rest.guard";
import { UserIdSignatureValidator } from "./user-id-signature.validator";

function createMockContext(
  headers: Record<string, string | undefined>,
): ExecutionContext {
  const req = { headers } as unknown as Request;
  return {
    getType: () => "http",
    switchToHttp: () =>
      ({
        getRequest: () => req,
      }) as unknown,
  } as unknown as ExecutionContext;
}

describe("UserIdSigRestGuard", () => {
  describe("with signing key configured", () => {
    let guard: UserIdSigRestGuard;

    beforeEach(() => {
      const validator = new UserIdSignatureValidator("test-signing-key");
      guard = new UserIdSigRestGuard(validator);
    });

    it("throws UnauthorizedException when signature is missing", () => {
      const ctx = createMockContext({ "x-user-id": "user-123" });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when signature is invalid", () => {
      const ctx = createMockContext({
        "x-user-id": "user-123",
        "x-user-id-sig": "invalid-signature",
      });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it("passes through when x-user-id is absent (controller returns 400)", () => {
      const ctx = createMockContext({});
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe("with empty signing key (fail-open rollout mode)", () => {
    let guard: UserIdSigRestGuard;

    beforeEach(() => {
      const validator = new UserIdSignatureValidator("");
      guard = new UserIdSigRestGuard(validator);
    });

    it("allows requests without a signature when the key is empty", () => {
      const ctx = createMockContext({ "x-user-id": "user-123" });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});
