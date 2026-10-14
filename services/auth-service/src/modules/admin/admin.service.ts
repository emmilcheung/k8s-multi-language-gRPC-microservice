import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { RefreshTokenService } from '../auth/refresh-token.service';
import {
  applyRoleChange,
  RoleTargetNotFoundError,
  type RoleChange,
  type RoleChangeResult,
} from './role-change';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /**
   * A grant takes effect at the user's next token issue. A removal also
   * revokes their refresh tokens, so no new access token can carry the role;
   * an access token already issued stays valid until it expires (JWT_EXPIRY,
   * 15 minutes by default). Removal revokes even when the role was already
   * gone, so a retry after a failed revocation finishes the job.
   */
  async changeRole(change: RoleChange): Promise<RoleChangeResult> {
    let result: RoleChangeResult;
    try {
      result = await applyRoleChange(this.db, change);
    } catch (err) {
      if (err instanceof RoleTargetNotFoundError) {
        throw new NotFoundException({
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
      }
      throw err;
    }
    if (change.action === 'remove') {
      await this.refreshTokens.revokeAllForUser(change.targetUserId);
    }
    return result;
  }
}
