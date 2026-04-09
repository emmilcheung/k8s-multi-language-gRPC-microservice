import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Manages opaque refresh tokens stored in Redis.
 *
 * Key format: `auth-service:refresh:<tokenId>`
 * Value:      userId (string)
 * TTL:        7 days
 *
 * On every refresh call the old token is deleted and a new one is issued
 * (rotation), which limits the blast radius of a stolen refresh token.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  private refreshTtlSeconds(): number {
    const raw = this.config.get<number | string>(
      'REFRESH_TOKEN_TTL_SECONDS',
      DEFAULT_REFRESH_TTL_SECONDS,
    );
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_REFRESH_TTL_SECONDS;
  }

  /** Issue a new refresh token for the given userId; returns the opaque token ID. */
  async issue(userId: string): Promise<string> {
    const tokenId = randomUUID();
    await this.redis.set(
      `auth-service:refresh:${tokenId}`,
      userId,
      'EX',
      this.refreshTtlSeconds(),
    );
    return tokenId;
  }

  /**
   * Validate a refresh token.
   * @throws UnauthorizedException if the token does not exist or has expired.
   * @returns userId associated with the token.
   */
  async validate(tokenId: string): Promise<string> {
    const userId = await this.redis.get(`auth-service:refresh:${tokenId}`);
    if (!userId) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or has expired',
        },
      });
    }
    return userId;
  }

  /** Delete a refresh token from Redis (used on rotation and signout). */
  async revoke(tokenId: string): Promise<void> {
    await this.redis.del(`auth-service:refresh:${tokenId}`);
  }
}
