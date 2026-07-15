import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { UserIdSignatureValidator } from "./user-id-signature.validator";

/**
 * REST counterpart of UserIdSigGuard (which covers the GraphQL path).
 *
 * Verifies the X-User-Id-Sig HMAC backstop on HTTP requests so the REST
 * surface enforces caller identity identically to GraphQL. When X-User-Id is
 * absent the guard passes through — the controller returns 400 MISSING_USER_ID.
 * When the signing key is unset the validator itself returns true (fail-open,
 * production-guarded at startup in app.module.ts).
 */
@Injectable()
export class UserIdSigRestGuard implements CanActivate {
  constructor(private readonly signatureValidator: UserIdSignatureValidator) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req) {
      return true;
    }

    const userId = req.headers["x-user-id"] as string | undefined;
    if (!userId) {
      return true;
    }

    const sig = req.headers["x-user-id-sig"] as string | undefined;
    if (!this.signatureValidator.isValidSignature(userId, sig)) {
      throw new UnauthorizedException("Invalid user identity signature");
    }

    return true;
  }
}
