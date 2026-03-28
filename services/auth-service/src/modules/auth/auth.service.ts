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
import { createPublicKey } from 'crypto';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.module';
import { UsersRepository } from '../users/users.repository';
import { RefreshTokenService } from './refresh-token.service';
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
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    // Load and validate RSA private key at construction time (fail loudly)
    this.rsaPrivateKey = parseRsaPrivateKey(
      this.config.getOrThrow<string>('RSA_PRIVATE_KEY'),
    );
  }

  async signup(email: string, password: string): Promise<AuthTokens> {
    const existing = await this.usersRepo.findByEmail(email);
    if (existing) {
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
    this.logger.info({ userId: user.id }, 'User created');

    const accessToken = this.issueToken({ sub: user.id, email: user.email });
    const refreshToken = await this.refreshTokenService.issue(user.id);
    return { accessToken, refreshToken };
  }

  async signin(email: string, password: string): Promise<AuthTokens> {
    const user = await this.usersRepo.findByEmail(email);
    if (!user) {
      // Constant-time failure to prevent user enumeration
      await argon2.hash('dummy-constant-time-comparison');
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    }

    this.logger.info({ userId: user.id }, 'User signed in');
    const accessToken = this.issueToken({ sub: user.id, email: user.email });
    const refreshToken = await this.refreshTokenService.issue(user.id);
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
      const decoded = this.jwtService.decode(token) as JwtPayload | null;
      if (!decoded?.jti || !decoded?.exp) {
        // Token is missing required claims — nothing to blacklist
        return;
      }
      const ttlSeconds = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttlSeconds <= 0) {
        // Already expired — no need to blacklist
        return;
      }
      await this.redis.set(
        `auth-service:blacklist:${decoded.jti}`,
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
}
