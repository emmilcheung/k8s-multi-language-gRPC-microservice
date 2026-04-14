import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const CONSENT_KEY_PREFIX = 'auth-service:oauth:pending-consent';
const CONSENT_TTL_SECONDS = 600; // 10 minutes

export interface PendingConsent {
  requestId: string;
  clientId: string;
  clientName: string;
  userId: string;
  scope: string; // space-delimited granted scopes
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  createdAt: string;
}

export interface ConsentSummary {
  requestId: string;
  clientId: string;
  clientName: string;
  scopes: string[]; // split for the UI
  expiresInSeconds: number;
}

@Injectable()
export class OAuthConsentStoreService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(requestId: string): string {
    return `${CONSENT_KEY_PREFIX}:${requestId}`;
  }

  async storePendingConsent(
    data: Omit<PendingConsent, 'requestId' | 'createdAt'>,
  ): Promise<string> {
    const requestId = randomUUID();
    const record: PendingConsent = {
      ...data,
      requestId,
      createdAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.key(requestId),
      JSON.stringify(record),
      'EX',
      CONSENT_TTL_SECONDS,
    );
    return requestId;
  }

  async getConsent(requestId: string): Promise<PendingConsent | null> {
    const raw = await this.redis.get(this.key(requestId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingConsent;
    } catch {
      return null;
    }
  }

  /** Consume (delete) a pending consent — single-use. */
  async consumeConsent(requestId: string): Promise<PendingConsent | null> {
    const record = await this.getConsent(requestId);
    if (!record) return null;
    await this.redis.del(this.key(requestId));
    return record;
  }
}
