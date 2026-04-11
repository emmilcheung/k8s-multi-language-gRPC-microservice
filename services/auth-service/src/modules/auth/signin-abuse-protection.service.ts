import { HttpException, HttpStatus, Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { REDIS_CLIENT } from '../redis/redis.module';

const DEFAULT_SIGNIN_FAILURE_WINDOW_SECONDS = 15 * 60;
const DEFAULT_SIGNIN_MAX_FAILURES = 5;
const DEFAULT_SIGNIN_LOCKOUT_SECONDS = 15 * 60;
const SIGNIN_ABUSE_KEY_PREFIX = 'auth-service:signin-abuse';

type SigninScope = 'ip' | 'identity' | 'identity-ip';

interface SubjectKey {
  scope: SigninScope;
  value: string;
}

@Injectable()
export class SigninAbuseProtectionService {
  constructor(
    @InjectPinoLogger(SigninAbuseProtectionService.name)
    private readonly logger: PinoLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async assertNotThrottled(
    email: string,
    ipAddress: string | null,
  ): Promise<void> {
    const subjects = this.subjects(email, ipAddress);
    const lockStates = await Promise.all(
      subjects.map(async (subject) => ({
        scope: subject.scope,
        locked: (await this.redis.exists(this.lockKey(subject))) > 0,
      })),
    );

    const activeLock = lockStates.find((state) => state.locked);
    if (activeLock) {
      this.logger.warn(
        { scope: activeLock.scope },
        'Sign-in attempt blocked by abuse protection',
      );
      throw new HttpException(
        {
          error: {
            code: 'TOO_MANY_SIGNIN_ATTEMPTS',
            message: 'Too many failed sign-in attempts. Try again later.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordFailure(email: string, ipAddress: string | null): Promise<void> {
    const subjects = this.subjects(email, ipAddress);
    for (const subject of subjects) {
      const counterKey = this.counterKey(subject);
      const failures = await this.redis.incr(counterKey);

      if (failures === 1) {
        await this.redis.expire(counterKey, this.failureWindowSeconds());
      }

      if (failures >= this.maxFailures()) {
        await Promise.all([
          this.redis.set(
            this.lockKey(subject),
            '1',
            'EX',
            this.lockoutSeconds(),
          ),
          this.redis.del(counterKey),
        ]);
        this.logger.warn(
          { scope: subject.scope },
          'Sign-in abuse threshold exceeded; lockout activated',
        );
      }
    }
  }

  async recordSuccess(email: string, ipAddress: string | null): Promise<void> {
    const subjects = this.subjects(email, ipAddress);
    const keys = subjects.flatMap((subject) => [
      this.counterKey(subject),
      this.lockKey(subject),
    ]);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  private failureWindowSeconds(): number {
    return this.positiveIntConfig(
      'SIGNIN_FAILURE_WINDOW_SECONDS',
      DEFAULT_SIGNIN_FAILURE_WINDOW_SECONDS,
    );
  }

  private maxFailures(): number {
    return this.positiveIntConfig(
      'SIGNIN_MAX_FAILURES',
      DEFAULT_SIGNIN_MAX_FAILURES,
    );
  }

  private lockoutSeconds(): number {
    return this.positiveIntConfig(
      'SIGNIN_LOCKOUT_SECONDS',
      DEFAULT_SIGNIN_LOCKOUT_SECONDS,
    );
  }

  private positiveIntConfig(key: string, fallback: number): number {
    const raw = this.config.get<number | string>(key, fallback);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }

  private subjects(email: string, ipAddress: string | null): SubjectKey[] {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedIp = ipAddress?.trim() || null;
    const subjects: SubjectKey[] = [];

    if (normalizedIp) {
      subjects.push({ scope: 'ip', value: normalizedIp });
      subjects.push({
        scope: 'identity-ip',
        value: `${normalizedEmail}|${normalizedIp}`,
      });
      return subjects;
    }

    subjects.push({ scope: 'identity', value: normalizedEmail });
    return subjects;
  }

  private counterKey(subject: SubjectKey): string {
    return `${SIGNIN_ABUSE_KEY_PREFIX}:counter:${subject.scope}:${this.hash(subject.value)}`;
  }

  private lockKey(subject: SubjectKey): string {
    return `${SIGNIN_ABUSE_KEY_PREFIX}:lock:${subject.scope}:${this.hash(subject.value)}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
