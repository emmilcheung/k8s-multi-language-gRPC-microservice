import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_KEY_PREFIX = 'auth-service:refresh';

interface RefreshTokenRecord {
  userId: string;
  tokenHash: string;
  issuedAt: string;
}

/**
 * Manages opaque refresh tokens stored in Redis.
 *
 * Public token format: `<selector>.<secret>`
 * Redis key format:    `auth-service:refresh:<selector>`
 * Value:               JSON document with userId + hash(secret)
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

  private refreshKey(selector: string): string {
    return `${REFRESH_TOKEN_KEY_PREFIX}:${selector}`;
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private parseToken(token: string): { selector: string; secret: string } | null {
    const [selector, secret, ...rest] = token.split('.');
    if (!selector || !secret || rest.length > 0) {
      return null;
    }
    return { selector, secret };
  }

  private decodeRecord(raw: string | null): RefreshTokenRecord | null {
    if (!raw) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'userId' in parsed &&
        'tokenHash' in parsed &&
        'issuedAt' in parsed &&
        typeof parsed.userId === 'string' &&
        typeof parsed.tokenHash === 'string' &&
        typeof parsed.issuedAt === 'string'
      ) {
        return parsed as RefreshTokenRecord;
      }
    } catch {
      return null;
    }

    return null;
  }

  private secretsMatch(expectedHash: string, providedSecret: string): boolean {
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = Buffer.from(this.hashSecret(providedSecret), 'hex');
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  private invalidRefreshToken(): UnauthorizedException {
    return new UnauthorizedException({
      error: {
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or has expired',
      },
    });
  }

  /** Issue a new refresh token for the given userId; returns the opaque token ID. */
  async issue(userId: string): Promise<string> {
    const selector = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const token = `${selector}.${secret}`;
    const record: RefreshTokenRecord = {
      userId,
      tokenHash: this.hashSecret(secret),
      issuedAt: new Date().toISOString(),
    };

    await this.redis.set(
      this.refreshKey(selector),
      JSON.stringify(record),
      'EX',
      this.refreshTtlSeconds(),
    );
    return token;
  }

  /**
   * Validate a refresh token.
   * @throws UnauthorizedException if the token does not exist or has expired.
   * @returns userId associated with the token.
   */
  async validate(tokenId: string): Promise<string> {
    const parts = this.parseToken(tokenId);
    if (!parts) {
      throw this.invalidRefreshToken();
    }

    const record = this.decodeRecord(
      await this.redis.get(this.refreshKey(parts.selector)),
    );
    if (!record || !this.secretsMatch(record.tokenHash, parts.secret)) {
      throw this.invalidRefreshToken();
    }

    return record.userId;
  }

  /** Delete a refresh token from Redis (used on rotation and signout). */
  async revoke(tokenId: string): Promise<void> {
    const parts = this.parseToken(tokenId);
    if (!parts) {
      return;
    }
    await this.redis.del(this.refreshKey(parts.selector));
  }
}
