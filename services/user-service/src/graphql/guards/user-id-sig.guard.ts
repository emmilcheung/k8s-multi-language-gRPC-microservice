import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import type { Request } from "express";
import { UserIdSignatureValidator } from "../../common/security/user-id-signature.validator";

@Injectable()
export class UserIdSigGuard implements CanActivate {
  constructor(private readonly signatureValidator: UserIdSignatureValidator) {}

  canActivate(context: ExecutionContext): boolean {
    const gqlContext = GqlExecutionContext.create(context);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const ctx = gqlContext.getContext();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const req = ctx.req as Request;

    if (!req) {
      return true;
    }

    const userId = req.headers["x-user-id"] as string | undefined;

    const sig = req.headers["x-user-id-sig"] as string | undefined;

    if (!userId) {
      return true;
    }

    if (!this.signatureValidator.isValidSignature(userId, sig)) {
      throw new UnauthorizedException("Invalid user identity signature");
    }

    return true;
  }
}
