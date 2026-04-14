import { Injectable, Inject } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const CODE_TTL_SECONDS = 600; // 10 minutes
const CODE_KEY_PREFIX = 'auth-service:oauth:code';
const SESSION_SCOPE_KEY_PREFIX = 'auth-service:oauth:session-scope';

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  userId: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  createdAt: string;
}

export interface SessionScopeRecord {
  scope: string;
  clientId: string;
}

@Injectable()
export class OAuthCodeStoreService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private codeKey(code: string): string {
    return `${CODE_KEY_PREFIX}:${code}`;
  }

  private sessionScopeKey(sessionId: string): string {
    return `${SESSION_SCOPE_KEY_PREFIX}:${sessionId}`;
  }

  /** Generate and store a new authorization code. Returns the opaque code string. */
  async storeCode(
    record: Omit<AuthorizationCodeRecord, 'code' | 'createdAt'>,
  ): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const fullRecord: AuthorizationCodeRecord = {
      ...record,
      code,
      createdAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.codeKey(code),
      JSON.stringify(fullRecord),
      'EX',
      CODE_TTL_SECONDS,
    );
    return code;
  }

  /**
   * Consume (read + delete) an authorization code.
   * Returns null if the code does not exist or has expired.
   * Single-use: the code is deleted regardless of whether validation succeeds.
   */
  async consumeCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const key = this.codeKey(code);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    // Delete immediately — codes are single-use
    await this.redis.del(key);

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'code' in parsed &&
        'clientId' in parsed &&
        'userId' in parsed &&
        'scope' in parsed &&
        'codeChallenge' in parsed &&
        'codeChallengeMethod' in parsed &&
        'redirectUri' in parsed &&
        'createdAt' in parsed
      ) {
        return parsed as AuthorizationCodeRecord;
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Store the scope and clientId associated with a refresh token session.
   * Called after issuing a refresh token so that subsequent refresh_token grants
   * can re-issue access tokens with the correct scope.
   */
  async storeSessionScope(
    sessionId: string,
    record: SessionScopeRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      this.sessionScopeKey(sessionId),
      JSON.stringify(record),
      'EX',
      ttlSeconds,
    );
  }

  /** Retrieve the scope metadata for a refresh token session. Returns null if not found. */
  async getSessionScope(sessionId: string): Promise<SessionScopeRecord | null> {
    const raw = await this.redis.get(this.sessionScopeKey(sessionId));
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'scope' in parsed &&
        'clientId' in parsed &&
        typeof (parsed as { scope: unknown }).scope === 'string' &&
        typeof (parsed as { clientId: unknown }).clientId === 'string'
      ) {
        return parsed as SessionScopeRecord;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Remove scope metadata for a session (called on revocation). */
  async deleteSessionScope(sessionId: string): Promise<void> {
    await this.redis.del(this.sessionScopeKey(sessionId));
  }
}
