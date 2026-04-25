import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { UserIdSigGuard } from "./user-id-sig.guard";
import { UserIdSignatureValidator } from "../../common/security/user-id-signature.validator";

function createMockContext(
  headers: Record<string, string | undefined>,
): ExecutionContext {
  const req = { headers } as Request;
  return {
    getType: () => "graphql",
    getClass: () => ({}),
    getHandler: () => ({}),
    getArgs: () => [{}, {}, { req }, {}],
    getArgByIndex: () => ({}),
    switchToHttp: () =>
      ({
        getRequest: () => req,
      }) as unknown,
    switchToRpc: () =>
      ({
        getRequest: () => req,
      }) as unknown,
    switchToWs: () =>
      ({
        getRequest: () => req,
      }) as unknown,
  } as unknown as ExecutionContext;
}

describe("UserIdSigGuard", () => {
  describe("with signing key configured", () => {
    let guard: UserIdSigGuard;

    beforeEach(() => {
      const validator = new UserIdSignatureValidator("test-signing-key");
      guard = new UserIdSigGuard(validator);
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

    it("allows requests without x-user-id (unauthenticated)", () => {
      const ctx = createMockContext({});
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe("with empty signing key (rollout mode)", () => {
    let guard: UserIdSigGuard;

    beforeEach(() => {
      const validator = new UserIdSignatureValidator("");
      guard = new UserIdSigGuard(validator);
    });

    it("allows requests without signature when key is empty", () => {
      const ctx = createMockContext({ "x-user-id": "user-123" });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});
