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
import { z } from 'zod';
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
  /** Absent on OAuth2 access tokens. */
  email?: string;
  jti: string;
  iat?: number;
  exp?: number;
  /** Present only on OAuth2 access tokens issued by the token endpoint. */
  scope?: string;
  /** Present only on OAuth2 access tokens — identifies the issuing client. */
  client_id?: string;
  /** User's assigned roles (additive claim for future authorization). */
  roles?: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const blacklisableAccessTokenSchema = z.object({
  jti: z.string().min(1),
  exp: z.number().int().positive(),
});

const jwtPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.email().optional(),
  jti: z.string().min(1),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
  scope: z.string().optional(),
  client_id: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

const oauthSubjectSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number().int().positive().optional(),
  exp: z.number().int().positive(),
  scope: z.string(),
  client_id: z.string().min(1),
});

/**
 * How long a "this client was disconnected at T" marker is kept. It only has to
 * outlive the longest access token (JWT_EXPIRY, default 15 min); a day is far past
 * any plausible setting and the key count is bounded by user revocations.
 */
const OAUTH_CLIENT_REVOCATION_TTL_SECONDS = 24 * 60 * 60;

const oauthClientRevokedAfterKey = (userId: string, clientId: string) =>
  `auth-service:oauth:revoked-after:${userId}:${clientId}`;

/** Verified claims of an OAuth access token used as a token-exchange subject. */
export type OAuthSubjectClaims = z.infer<typeof oauthSubjectSchema>;

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

    const accessToken = this.issueToken({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
    const refreshToken = await this.refreshTokenService.issue(
      user.id,
      sessionMetadata,
      null,
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
    const accessToken = this.issueToken({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
    const refreshToken = await this.refreshTokenService.issue(
      user.id,
      sessionMetadata,
      null,
    );
    return { accessToken, refreshToken };
  }

  /**
   * Issue a new access token for a userId (used during refresh token rotation).
   * Looks up the user by ID to include the email claim and roles.
   */
  async issueAccessTokenForUser(userId: string): Promise<string> {
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      throw new UnauthorizedException({
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    return this.issueToken({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
  }

  async lookupUserByEmail(email: string): Promise<CurrentUser | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return null;
    const user = await this.usersRepo.findByEmail(normalizedEmail);
    if (!user) return null;
    return { id: user.id, email: user.email };
  }

  async lookupUserByID(id: string): Promise<CurrentUser | null> {
    const normalizedID = id.trim();
    if (!normalizedID) return null;
    const user = await this.usersRepo.findById(normalizedID);
    if (!user) return null;
    return { id: user.id, email: user.email };
  }

  /**
   * Issue an access token for an OAuth2 client with specific scopes.
   * Adds `scope` and `client_id`, and binds the token to `aud` (RFC 8707) and
   * `iss`. No `email` or `roles`: a delegated token carries only what the
   * resource server needs. Used by the OAuth2 token endpoint only.
   */
  issueAccessTokenForOAuth(
    userId: string,
    scope: string,
    clientId: string,
    {
      aud,
      iss,
      act,
      iat,
      exp,
    }: {
      aud: string;
      iss: string;
      /** RFC 8693 actor claim, set only on exchanged tokens. */
      act?: { sub: string };
      /**
       * Absolute iat/exp (epoch seconds) for exchanged tokens. Set
       * together; replaces JWT_EXPIRY so the lifetime is computed once by the
       * caller and cannot drift past the subject token's exp.
       */
      iat?: number;
      exp?: number;
    },
  ): string {
    const tokenPayload = {
      sub: userId,
      jti: randomUUID(),
      scope,
      client_id: clientId,
      ...(act ? { act } : {}),
      ...(iat !== undefined ? { iat } : {}),
    };
    const token: unknown = (
      this.jwtService.sign as (p: unknown, o: unknown) => unknown
    )(tokenPayload, {
      audience: aud,
      issuer: iss,
      // jsonwebtoken derives exp = payload.iat + expiresIn, so with an explicit
      // iat this yields exactly the absolute exp (no clock read at sign time).
      ...(iat !== undefined && exp !== undefined
        ? { expiresIn: exp - iat }
        : {}),
    });
    return token as string;
  }

  /**
   * Verify an OAuth access token presented as an RFC 8693 subject:
   * signature, exp, an `iss` that is either issuer this server can mint OAuth
   * tokens under (the module's dual-issuer list, independent of
   * OAUTH_ISSUER_ENABLED so tokens minted just before a flag flip still
   * exchange), and the revocation blacklist. Unlike
   * verifyAccessToken it keeps `iss`/`aud`, which the caller must check.
   * Throws UnauthorizedException for any failure.
   */
  async verifyOAuthSubjectToken(token: string): Promise<OAuthSubjectClaims> {
    let claims: OAuthSubjectClaims;
    try {
      claims = oauthSubjectSchema.parse(
        await this.jwtService.verifyAsync<object>(token),
      );
    } catch {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Access token is invalid or expired',
        },
      });
    }
    const [blacklisted, revokedAfter] = await Promise.all([
      this.redis.get(`auth-service:blacklist:${claims.jti}`),
      this.redis.get(oauthClientRevokedAfterKey(claims.sub, claims.client_id)),
    ]);
    // A disconnect invalidates every token the client got before it, so no
    // fresh exchange can succeed on a token that is still within its lifetime. A
    // token without iat cannot be placed before or after, so it fails closed.
    const disconnected =
      revokedAfter !== null &&
      (claims.iat === undefined || claims.iat <= Number(revokedAfter));
    if (blacklisted || disconnected) {
      throw new UnauthorizedException({
        error: {
          code: 'TOKEN_REVOKED',
          message: 'Access token has been revoked',
        },
      });
    }
    return claims;
  }

  /**
   * Cut off every OAuth access token already issued to `clientId` for `userId`
   * (Connected apps → Disconnect). Tokens are stateless, so this records a
   * not-before time that verifyOAuthSubjectToken enforces on every exchange.
   */
  async revokeOAuthClientAccess(
    userId: string,
    clientId: string,
  ): Promise<void> {
    await this.redis.set(
      oauthClientRevokedAfterKey(userId, clientId),
      String(Math.floor(Date.now() / 1000)),
      'EX',
      OAUTH_CLIENT_REVOCATION_TTL_SECONDS,
    );
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
      this.logger.error(
        { err: err instanceof Error ? err : undefined },
        'Failed to export JWKS public key',
      );
      throw new InternalServerErrorException({
        error: { code: 'JWKS_ERROR', message: 'Failed to load JWKS' },
      });
    }
  }

  /**
   * Verify an access token's signature and check whether its JTI has been
   * blacklisted (e.g. due to an explicit signout).
   *
   * Used by the currentUser endpoint for defense-in-depth verification:
   * in addition to trusting the X-User-Id header injected by Kong, we locally
   * verify the JWT so that direct (non-Kong) pod access is also rejected for
   * unauthenticated callers.
   *
   * Returns the verified payload on success. Throws UnauthorizedException if
   * the token is invalid, expired, or blacklisted. Accepts the session issuer
   * only; callers that must also refuse OAuth tokens minted under that issuer
   * (flag off) use verifySessionAccessToken.
   */
  async verifyAccessToken(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      // Session tokens only: the module verifies both issuers (OAuth subject tokens
      // need that), so narrow to the session issuer here. A third-party OAuth token
      // minted for another client or resource is never a session.
      payload = jwtPayloadSchema.parse(
        await (
          this.jwtService.verifyAsync as (
            value: string,
            options: { issuer: string },
          ) => Promise<unknown>
        )(token, { issuer: 'auth-service' }),
      );
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
   * Verify a token that must represent a signed-in browser session. OAuth
   * access tokens (they carry client_id) are rejected: a delegated grant
   * is never a session.
   */
  async verifySessionAccessToken(token: string): Promise<JwtPayload> {
    const payload = await this.verifyAccessToken(token);
    if (payload.client_id !== undefined) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Access token is invalid or expired',
        },
      });
    }
    return payload;
  }

  /**
   * Blacklist a JWT access token by its JTI until it expires.
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
      const decoded = this.decodeBlacklisableAccessToken(token);
      if (!decoded) {
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
    // Embed a unique JTI so the token can be individually revoked on signout.
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

  private decodeBlacklisableAccessToken(
    token: string,
  ): z.infer<typeof blacklisableAccessTokenSchema> | null {
    const decoded = (this.jwtService.decode as (value: string) => unknown)(
      token,
    );
    const parsed = blacklisableAccessTokenSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  }
}
