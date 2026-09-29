import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { OAUTH_SESSION_SCOPE_KEY_PREFIX } from '../oauth/oauth-code-store.service';

const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_SESSION_KEY_PREFIX = 'auth-service:refresh:session';
const USER_SESSION_INDEX_PREFIX = 'auth-service:user-sessions';

export interface SessionMetadata {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface RefreshSession {
  sessionId: string;
  userId: string;
  createdAt: string;
  lastRotatedAt: string;
  userAgent: string | null;
  ipAddress: string | null;
}

/** Who may rotate a refresh session: the browser, or one OAuth client (C-11). */
export type RefreshAudience =
  | { kind: 'browser' }
  | { kind: 'oauth'; clientId: string };

interface RefreshTokenRecord extends RefreshSession {
  tokenHash: string;
  /**
   * OAuth client that owns the session; null for a browser session. Absent on
   * records written before F1; resolveOAuthClientId falls back to the
   * session-scope marker for those (removed by WS-N at deploy + 7 d).
   */
  oauthClientId?: string | null;
}

/**
 * Manages opaque refresh tokens stored in Redis.
 *
 * Public token format: `<sessionId>.<secret>`
 * Redis key format:    `auth-service:refresh:session:<sessionId>`
 * Value:               JSON document with session metadata + hash(secret)
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

  private sessionKey(sessionId: string): string {
    return `${REFRESH_SESSION_KEY_PREFIX}:${sessionId}`;
  }

  private userSessionsKey(userId: string): string {
    return `${USER_SESSION_INDEX_PREFIX}:${userId}`;
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private normalizeMetadata(
    metadata: SessionMetadata,
  ): Required<SessionMetadata> {
    return {
      userAgent: metadata.userAgent?.trim() ? metadata.userAgent.trim() : null,
      ipAddress: metadata.ipAddress?.trim() ? metadata.ipAddress.trim() : null,
    };
  }

  private parseToken(
    token: string,
  ): { sessionId: string; secret: string } | null {
    const [sessionId, secret, ...rest] = token.split('.');
    if (!sessionId || !secret || rest.length > 0) {
      return null;
    }
    return { sessionId, secret };
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
        'sessionId' in parsed &&
        'userId' in parsed &&
        'createdAt' in parsed &&
        'lastRotatedAt' in parsed &&
        'userAgent' in parsed &&
        'ipAddress' in parsed &&
        'tokenHash' in parsed &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.userId === 'string' &&
        typeof parsed.createdAt === 'string' &&
        typeof parsed.lastRotatedAt === 'string' &&
        (parsed.userAgent === null || typeof parsed.userAgent === 'string') &&
        (parsed.ipAddress === null || typeof parsed.ipAddress === 'string') &&
        typeof parsed.tokenHash === 'string' &&
        (!('oauthClientId' in parsed) ||
          parsed.oauthClientId === null ||
          typeof parsed.oauthClientId === 'string')
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

  private buildToken(sessionId: string): { token: string; tokenHash: string } {
    const secret = randomBytes(32).toString('base64url');
    return {
      token: `${sessionId}.${secret}`,
      tokenHash: this.hashSecret(secret),
    };
  }

  private async readSessionRecord(
    sessionId: string,
  ): Promise<RefreshTokenRecord | null> {
    return this.decodeRecord(await this.redis.get(this.sessionKey(sessionId)));
  }

  private toSession(record: RefreshTokenRecord): RefreshSession {
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      createdAt: record.createdAt,
      lastRotatedAt: record.lastRotatedAt,
      userAgent: record.userAgent,
      ipAddress: record.ipAddress,
    };
  }

  private async persistSession(record: RefreshTokenRecord): Promise<void> {
    await this.redis.set(
      this.sessionKey(record.sessionId),
      JSON.stringify(record),
      'EX',
      this.refreshTtlSeconds(),
    );
    await this.redis.sadd(
      this.userSessionsKey(record.userId),
      record.sessionId,
    );
  }

  private async loadValidatedRecord(
    token: string,
  ): Promise<RefreshTokenRecord> {
    const parts = this.parseToken(token);
    if (!parts) {
      throw this.invalidRefreshToken();
    }

    const record = await this.readSessionRecord(parts.sessionId);
    if (!record || !this.secretsMatch(record.tokenHash, parts.secret)) {
      throw this.invalidRefreshToken();
    }

    return record;
  }

  /**
   * The OAuth client that owns a session, or null for a browser session.
   * Legacy records carry no owner: the session-scope marker decides (no marker
   * means browser), and a marker we cannot read fails closed.
   */
  private async resolveOAuthClientId(
    record: RefreshTokenRecord,
  ): Promise<string | null> {
    if (record.oauthClientId !== undefined) {
      return record.oauthClientId;
    }
    const marker = await this.redis.get(
      `${OAUTH_SESSION_SCOPE_KEY_PREFIX}:${record.sessionId}`,
    );
    if (marker === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(marker);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'clientId' in parsed &&
        typeof parsed.clientId === 'string'
      ) {
        return parsed.clientId;
      }
    } catch {
      // fall through: unreadable marker
    }
    throw this.invalidRefreshToken();
  }

  /**
   * Issue a new refresh token; returns the opaque token. `oauthClientId` is the
   * OAuth client that owns the session, or null for a browser sign-in. It is
   * required so every caller has to choose.
   */
  async issue(
    userId: string,
    metadata: SessionMetadata,
    oauthClientId: string | null,
  ): Promise<string> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const { token, tokenHash } = this.buildToken(sessionId);
    const normalizedMetadata = this.normalizeMetadata(metadata);
    const record: RefreshTokenRecord = {
      sessionId,
      userId,
      tokenHash,
      createdAt: now,
      lastRotatedAt: now,
      userAgent: normalizedMetadata.userAgent,
      ipAddress: normalizedMetadata.ipAddress,
      oauthClientId,
    };

    await this.persistSession(record);
    return token;
  }

  /**
   * Rotate a refresh token for the given audience. A session owned by another
   * audience is rejected before anything is written, so its real holder keeps
   * a working token (F1, F1b).
   */
  async rotate(
    token: string,
    metadata: SessionMetadata,
    audience: RefreshAudience,
  ): Promise<{ userId: string; refreshToken: string; sessionId: string }> {
    const record = await this.loadValidatedRecord(token);
    const owner = await this.resolveOAuthClientId(record);
    const expected = audience.kind === 'oauth' ? audience.clientId : null;
    if (owner !== expected) {
      throw this.invalidRefreshToken();
    }

    const { token: refreshToken, tokenHash } = this.buildToken(
      record.sessionId,
    );
    const normalizedMetadata = this.normalizeMetadata(metadata);

    const updatedRecord: RefreshTokenRecord = {
      ...record,
      tokenHash,
      lastRotatedAt: new Date().toISOString(),
      userAgent: normalizedMetadata.userAgent ?? record.userAgent,
      ipAddress: normalizedMetadata.ipAddress ?? record.ipAddress,
      oauthClientId: owner,
    };

    await this.persistSession(updatedRecord);
    return {
      userId: updatedRecord.userId,
      refreshToken,
      sessionId: updatedRecord.sessionId,
    };
  }

  /**
   * Validate a refresh token.
   * @throws UnauthorizedException if the token does not exist or has expired.
   * @returns userId associated with the token.
   */
  async validate(tokenId: string): Promise<string> {
    const record = await this.loadValidatedRecord(tokenId);
    return record.userId;
  }

  extractSessionId(token: string | undefined): string | null {
    if (!token) {
      return null;
    }
    return this.parseToken(token)?.sessionId ?? null;
  }

  async listSessions(userId: string): Promise<RefreshSession[]> {
    const sessionIds = await this.redis.smembers(this.userSessionsKey(userId));
    const sessions = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const record = await this.readSessionRecord(sessionId);
        if (!record || record.userId !== userId) {
          await this.redis.srem(this.userSessionsKey(userId), sessionId);
          return null;
        }
        return this.toSession(record);
      }),
    );

    return sessions
      .filter((session): session is RefreshSession => session !== null)
      .sort((left, right) =>
        right.lastRotatedAt.localeCompare(left.lastRotatedAt),
      );
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const record = await this.readSessionRecord(sessionId);
    if (!record) {
      await this.redis.srem(this.userSessionsKey(userId), sessionId);
      return false;
    }

    if (record.userId !== userId) {
      return false;
    }

    await Promise.all([
      this.redis.del(this.sessionKey(sessionId)),
      this.redis.srem(this.userSessionsKey(userId), sessionId),
    ]);
    return true;
  }

  /** Delete a refresh token from Redis (used on rotation and signout). */
  async revoke(tokenId: string): Promise<void> {
    const parts = this.parseToken(tokenId);
    if (!parts) {
      return;
    }

    const record = await this.readSessionRecord(parts.sessionId);
    await this.redis.del(this.sessionKey(parts.sessionId));
    if (record) {
      await this.redis.srem(
        this.userSessionsKey(record.userId),
        parts.sessionId,
      );
    }
  }
}
