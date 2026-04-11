import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import * as argon2 from 'argon2';
import { createHash, createPublicKey, randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.module';
import { UsersRepository } from '../users/users.repository';
import {
  RefreshTokenService,
  type SessionMetadata,
} from './refresh-token.service';
import { SigninAbuseProtectionService } from './signin-abuse-protection.service';
import { parseRsaPrivateKey } from './rsa-key.util';

export interface JwtPayload {
  sub: string;
  email: string;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface CurrentUser {
  id: string;
  email: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly rsaPrivateKey: string;

  constructor(
    @InjectPinoLogger(AuthService.name)
    private readonly logger: PinoLogger,
    private readonly usersRepo: UsersRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly signinAbuseProtectionService: SigninAbuseProtectionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    // Load and validate RSA private key at construction time (fail loudly)
    this.rsaPrivateKey = parseRsaPrivateKey(
      this.config.getOrThrow<string>('RSA_PRIVATE_KEY'),
    );
  }

  async signup(
    email: string,
    password: string,
    sessionMetadata: SessionMetadata = {},
  ): Promise<AuthTokens> {
    const existing = await this.usersRepo.findByEmail(email);
    if (existing) {
      this.logger.warn(
        {
          event: 'auth.signup.conflict',
          emailHash: this.hashAuditValue(email),
        },
        'Auth audit event',
      );
      throw new ConflictException({
        error: {
          code: 'EMAIL_IN_USE',
          message: 'An account with this email already exists',
        },
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MiB
      timeCost: 3,
      parallelism: 4,
    });

    const user = await this.usersRepo.create(email, passwordHash);
    this.logger.info(
      {
        event: 'auth.signup.succeeded',
        userId: user.id,
        emailHash: this.hashAuditValue(user.email),
      },
      'Auth audit event',
    );

    const accessToken = this.issueToken({ sub: user.id, email: user.email });
    const refreshToken = await this.refreshTokenService.issue(
      user.id,
      sessionMetadata,
    );
    return { accessToken, refreshToken };
  }

  async signin(
    email: string,
    password: string,
    sessionMetadata: SessionMetadata = {},
  ): Promise<AuthTokens> {
    await this.signinAbuseProtectionService.assertNotThrottled(
      email,
      sessionMetadata.ipAddress ?? null,
    );

    const user = await this.usersRepo.findByEmail(email);
    if (!user) {
      // Constant-time failure to prevent user enumeration
      await argon2.hash('dummy-constant-time-comparison');
      await this.signinAbuseProtectionService.recordFailure(
        email,
        sessionMetadata.ipAddress ?? null,
      );
      this.logger.warn(
        {
          event: 'auth.signin.failed',
          reason: 'user_not_found',
          emailHash: this.hashAuditValue(email),
          ipHash: this.hashAuditValue(sessionMetadata.ipAddress),
        },
        'Auth audit event',
      );
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      await this.signinAbuseProtectionService.recordFailure(
        email,
        sessionMetadata.ipAddress ?? null,
      );
      this.logger.warn(
        {
          event: 'auth.signin.failed',
          reason: 'invalid_password',
          userId: user.id,
          emailHash: this.hashAuditValue(email),
          ipHash: this.hashAuditValue(sessionMetadata.ipAddress),
        },
        'Auth audit event',
      );
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    await this.signinAbuseProtectionService.recordSuccess(
      email,
      sessionMetadata.ipAddress ?? null,
    );

    this.logger.info(
      {
        event: 'auth.signin.succeeded',
        userId: user.id,
        emailHash: this.hashAuditValue(user.email),
        ipHash: this.hashAuditValue(sessionMetadata.ipAddress),
      },
      'Auth audit event',
    );
    const accessToken = this.issueToken({ sub: user.id, email: user.email });
    const refreshToken = await this.refreshTokenService.issue(
      user.id,
      sessionMetadata,
    );
    return { accessToken, refreshToken };
  }

  /**
   * Issue a new access token for a userId (used during refresh token rotation).
   * Looks up the user by ID to include the email claim.
   */
  async issueAccessTokenForUser(userId: string): Promise<string> {
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      throw new UnauthorizedException({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    return this.issueToken({ sub: user.id, email: user.email });
  }

  getJwks(): object {
    try {
      const publicKey = createPublicKey(this.rsaPrivateKey);
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        keys: [
          {
            ...jwk,
            use: 'sig',
            alg: 'RS256',
            kid: 'auth-service-key-1',
          },
        ],
      };
    } catch (err) {
      this.logger.error({ err }, 'Failed to export JWKS public key');
      throw new InternalServerErrorException({
        error: { code: 'JWKS_ERROR', message: 'Failed to load JWKS' },
      });
    }
  }

  /**
   * Verify an access token's signature and check whether its JTI has been
   * blacklisted (e.g. due to an explicit signout).
   *
   * Used by the currentUser endpoint for defense-in-depth verification (S-03):
   * in addition to trusting the X-User-Id header injected by Kong, we locally
   * verify the JWT so that direct (non-Kong) pod access is also rejected for
   * unauthenticated callers.
   *
   * Returns the verified payload on success. Throws UnauthorizedException if
   * the token is invalid, expired, or blacklisted.
   */
  async verifyAccessToken(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Access token is invalid or expired',
        },
      });
    }

    if (payload.jti) {
      const blacklisted = await this.redis.get(
        `auth-service:blacklist:${payload.jti}`,
      );
      if (blacklisted) {
        throw new UnauthorizedException({
          error: {
            code: 'TOKEN_REVOKED',
            message: 'Access token has been revoked',
          },
        });
      }
    }

    return payload;
  }

  /**
   * Blacklist a JWT access token by its JTI until it expires (S-04).
   * Decodes the token without verification (Kong already validated it upstream).
   * Stores the JTI in Redis with TTL = remaining token lifetime so the key
   * is automatically cleaned up once the token can no longer be used.
   * Kong and downstream services should check this blacklist via JWKS validation.
   *
   * Note: Kong performs its own JWT verification before forwarding requests.
   * This blacklist is a defence-in-depth measure for the auth-service's own
   * token issuance; services that rely solely on Kong JWT verification will
   * not check this list — they rely on short token lifetimes (15 min) as the
   * primary defence against stolen tokens post-signout.
   */
  async blacklistAccessToken(token: string): Promise<void> {
    try {
      // Decode without verification — we only need the JTI and expiry claims
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const decoded = this.jwtService.decode(token);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!decoded?.jti || !decoded?.exp) {
        // Token is missing required claims — nothing to blacklist
        return;
      }

      const ttlSeconds =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (decoded.exp as number) - Math.floor(Date.now() / 1000);
      if (ttlSeconds <= 0) {
        // Already expired — no need to blacklist
        return;
      }
      await this.redis.set(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `auth-service:blacklist:${decoded.jti as string}`,
        '1',
        'EX',
        ttlSeconds,
      );
    } catch {
      // Best-effort — never throw from a signout path
      this.logger.warn('Failed to blacklist access token; ignoring');
    }
  }

  private issueToken(payload: Omit<JwtPayload, 'jti' | 'iat' | 'exp'>): string {
    // Embed a unique JTI so the token can be individually revoked on signout (S-04).
    const tokenPayload = { ...payload, jti: randomUUID() };
    // JwtService.sign return type is `any` in @nestjs/jwt typings.
    // We call it via an intermediate `unknown` cast to satisfy strict-any rules.
    const token: unknown = (this.jwtService.sign as (p: unknown) => unknown)(
      tokenPayload,
    );
    return token as string;
  }

  private hashAuditValue(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized) {
      return null;
    }
    return createHash('sha256').update(normalized.toLowerCase()).digest('hex');
  }
}
