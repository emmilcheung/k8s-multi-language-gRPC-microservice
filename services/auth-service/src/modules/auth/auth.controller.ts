import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import ms from 'ms';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuthService } from './auth.service';
import { SignupDto, SigninDto } from './auth.dto';
import {
  RefreshTokenService,
  type SessionMetadata,
} from './refresh-token.service';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'token';
const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_COOKIE_PATH = '/';

@Controller()
export class AuthController {
  constructor(
    @InjectPinoLogger(AuthController.name)
    private readonly logger: PinoLogger,
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly config: ConfigService,
  ) {}

  // POST /api/users/signup
  @Post('api/users/signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.signup(
      dto.email,
      dto.password,
      this.sessionMetadataFromRequest(req),
    );
    this.setAccessTokenCookie(res, accessToken);
    this.setRefreshTokenCookie(res, refreshToken);
    return { currentUser: { email: dto.email } };
  }

  // POST /api/users/signin
  @Post('api/users/signin')
  @HttpCode(HttpStatus.OK)
  async signin(
    @Body() dto: SigninDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.signin(
      dto.email,
      dto.password,
      this.sessionMetadataFromRequest(req),
    );
    this.setAccessTokenCookie(res, accessToken);
    this.setRefreshTokenCookie(res, refreshToken);
    return { currentUser: { email: dto.email } };
  }

  // POST /api/users/signout — clears cookies and revokes the refresh token
  @Post('api/users/signout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const oldRefreshToken = req.cookies[this.refreshTokenCookieName()] as
      | string
      | undefined;
    const currentSessionId =
      this.refreshTokenService.extractSessionId(oldRefreshToken);
    if (oldRefreshToken) {
      // Best-effort revocation — don't throw if the token is already gone
      await this.refreshTokenService.revoke(oldRefreshToken).catch(() => {});
    }

    // Blacklist the access token so it cannot be reused before it naturally
    // expires. This is a defence-in-depth measure — the primary defence is the
    // short (15 min) token lifetime (S-04).
    const accessToken = req.cookies[this.accessTokenCookieName()] as
      | string
      | undefined;
    if (accessToken) {
      await this.authService.blacklistAccessToken(accessToken);
    }

    this.clearAuthCookies(res);
    this.logger.info(
      {
        event: 'auth.signout.completed',
        sessionId: currentSessionId,
        hadAccessToken: Boolean(accessToken),
      },
      'Auth audit event',
    );
  }

  // POST /api/auth/refresh — rotate refresh token and issue new access token
  @Post('api/auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const oldRefreshToken = req.cookies[this.refreshTokenCookieName()] as
      | string
      | undefined;
    if (!oldRefreshToken) {
      throw new UnauthorizedException({
        error: {
          code: 'MISSING_REFRESH_TOKEN',
          message: 'Refresh token cookie is required',
        },
      });
    }

    const { userId, refreshToken } = await this.refreshTokenService.rotate(
      oldRefreshToken,
      this.sessionMetadataFromRequest(req),
    );

    const accessToken = await this.authService.issueAccessTokenForUser(userId);

    this.setAccessTokenCookie(res, accessToken);
    this.setRefreshTokenCookie(res, refreshToken);
    this.logger.info(
      {
        event: 'auth.refresh.succeeded',
        userId,
        sessionId: this.refreshTokenService.extractSessionId(refreshToken),
      },
      'Auth audit event',
    );
    return {};
  }

  @Get('api/users/sessions')
  @HttpCode(HttpStatus.OK)
  async listSessions(@Req() req: Request) {
    const currentUser = await this.requireAuthenticatedUser(req);
    const currentSessionId = this.refreshTokenService.extractSessionId(
      req.cookies[this.refreshTokenCookieName()] as string | undefined,
    );
    const sessions = await this.refreshTokenService.listSessions(
      currentUser.id,
    );

    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        lastRotatedAt: session.lastRotatedAt,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        current: session.sessionId === currentSessionId,
      })),
    };
  }

  @Delete('api/users/sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const currentUser = await this.requireAuthenticatedUser(req);
    const revoked = await this.refreshTokenService.revokeSession(
      currentUser.id,
      sessionId,
    );

    if (!revoked) {
      this.logger.warn(
        {
          event: 'auth.session.revoke.missed',
          userId: currentUser.id,
          sessionId,
        },
        'Auth audit event',
      );
      throw new NotFoundException({
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });
    }

    const currentSessionId = this.refreshTokenService.extractSessionId(
      req.cookies[this.refreshTokenCookieName()] as string | undefined,
    );
    if (currentSessionId === sessionId) {
      this.clearAuthCookies(res);
    }

    this.logger.info(
      {
        event: 'auth.session.revoked',
        userId: currentUser.id,
        sessionId,
        currentSessionRevoked: currentSessionId === sessionId,
      },
      'Auth audit event',
    );
  }

  // GET /api/users/currentuser
  // Kong injects X-User-Id after JWT verification. As a defense-in-depth
  // measure (S-03), we also verify the JWT from the cookie ourselves so that
  // direct pod access (bypassing Kong) is rejected for unauthenticated callers.
  @Get('api/users/currentuser')
  @HttpCode(HttpStatus.OK)
  async currentUser(@Req() req: Request) {
    const kongUserId = req.headers['x-user-id'] as string | undefined;
    const token = req.cookies[this.accessTokenCookieName()] as
      | string
      | undefined;

    // Fast path: no token and no Kong-injected header → not authenticated.
    if (!token && !kongUserId) {
      return { currentUser: null };
    }

    // If a token cookie is present, verify it locally (signature + blacklist).
    // This catches cases where someone bypasses Kong and hits the pod directly.
    if (token) {
      try {
        const payload = await this.authService.verifyAccessToken(token);
        // Cross-check: if Kong also set X-User-Id, it must match the JWT sub.
        if (kongUserId && kongUserId !== payload.sub) {
          // Header/token mismatch — reject the request rather than trust either.
          return { currentUser: null };
        }
        return { currentUser: { id: payload.sub, email: payload.email } };
      } catch {
        // Token present but invalid/revoked — treat as unauthenticated.
        return { currentUser: null };
      }
    }

    // No cookie but Kong set X-User-Id (e.g. API client using Bearer header).
    // Trust Kong's validation; return a minimal identity without email.
    return { currentUser: { id: kongUserId } };
  }

  // GET /.well-known/jwks.json — public key endpoint consumed by Kong
  @Get('.well-known/jwks.json')
  @HttpCode(HttpStatus.OK)
  jwks() {
    return this.authService.getJwks();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private isProduction(): boolean {
    return this.config.get('NODE_ENV') === 'production';
  }

  private accessTokenCookieName(): string {
    return this.config.get<string>(
      'JWT_COOKIE_NAME',
      DEFAULT_ACCESS_TOKEN_COOKIE,
    );
  }

  private refreshTokenCookieName(): string {
    return this.config.get<string>(
      'REFRESH_COOKIE_NAME',
      DEFAULT_REFRESH_TOKEN_COOKIE,
    );
  }

  private refreshTokenTtlSeconds(): number {
    const raw = this.config.get<number | string>(
      'REFRESH_TOKEN_TTL_SECONDS',
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    );
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  }

  private refreshCookiePath(): string {
    return this.config.get<string>(
      'REFRESH_COOKIE_PATH',
      DEFAULT_REFRESH_COOKIE_PATH,
    );
  }

  private parseSameSite(
    raw: string | undefined,
    fallback: 'strict' | 'lax' | 'none',
  ): 'strict' | 'lax' | 'none' {
    const value = raw?.toLowerCase();
    if (value === 'strict' || value === 'lax' || value === 'none') {
      return value;
    }
    return fallback;
  }

  private accessTokenSameSite(): 'strict' | 'lax' | 'none' {
    return this.parseSameSite(
      this.config.get<string>('ACCESS_TOKEN_COOKIE_SAME_SITE'),
      'strict',
    );
  }

  private refreshTokenSameSite(): 'strict' | 'lax' | 'none' {
    return this.parseSameSite(
      this.config.get<string>('REFRESH_TOKEN_COOKIE_SAME_SITE'),
      'strict',
    );
  }

  private cookieDomain(): string | undefined {
    const domain = this.config.get<string>('COOKIE_DOMAIN');
    return domain?.trim() ? domain : undefined;
  }

  private sessionMetadataFromRequest(req: Request): SessionMetadata {
    return {
      userAgent: this.firstHeaderValue(req.headers['user-agent']),
      ipAddress: this.extractClientIp(req),
    };
  }

  private firstHeaderValue(
    value: string | string[] | undefined,
  ): string | null {
    if (Array.isArray(value)) {
      return value[0]?.trim() || null;
    }
    return value?.trim() || null;
  }

  private extractClientIp(req: Request): string | null {
    const forwarded = this.firstHeaderValue(req.headers['x-forwarded-for']);
    if (forwarded) {
      return forwarded.split(',')[0]?.trim() || null;
    }

    const realIp = this.firstHeaderValue(req.headers['x-real-ip']);
    if (realIp) {
      return realIp;
    }

    return req.ip?.trim() || null;
  }

  private async requireAuthenticatedUser(
    req: Request,
  ): Promise<{ id: string }> {
    const kongUserId = req.headers['x-user-id'] as string | undefined;
    const token = req.cookies[this.accessTokenCookieName()] as
      | string
      | undefined;

    if (!token && !kongUserId) {
      throw new UnauthorizedException({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }

    if (token) {
      try {
        const payload = await this.authService.verifyAccessToken(token);
        if (kongUserId && kongUserId !== payload.sub) {
          throw new UnauthorizedException({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required',
            },
          });
        }
        return { id: payload.sub };
      } catch {
        throw new UnauthorizedException({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          },
        });
      }
    }

    return { id: kongUserId! };
  }

  private clearAuthCookies(res: Response): void {
    const accessCookieName = this.accessTokenCookieName();
    const refreshCookieName = this.refreshTokenCookieName();
    const domain = this.cookieDomain();
    const refreshPath = this.refreshCookiePath();

    res.clearCookie(accessCookieName, {
      path: '/',
      ...(domain ? { domain } : {}),
    });
    res.clearCookie(refreshCookieName, {
      path: refreshPath,
      ...(domain ? { domain } : {}),
    });

    // Compatibility clean-up for older deployments that scoped refresh cookies
    // to a different path.
    if (refreshPath !== '/') {
      res.clearCookie(refreshCookieName, {
        path: '/',
        ...(domain ? { domain } : {}),
      });
    }
    if (refreshPath !== '/api/auth/refresh') {
      res.clearCookie(refreshCookieName, {
        path: '/api/auth/refresh',
        ...(domain ? { domain } : {}),
      });
    }
  }

  private setAccessTokenCookie(res: Response, token: string): void {
    // Derive maxAge from JWT_EXPIRY config so cookie lifetime stays in sync
    // with the token's actual validity window (S-06).
    const expiry = this.config.get<string>('JWT_EXPIRY', '15m');
    const maxAgeMs = ms(expiry as Parameters<typeof ms>[0]) ?? 15 * 60 * 1000;
    const domain = this.cookieDomain();
    res.cookie(this.accessTokenCookieName(), token, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: this.accessTokenSameSite(),
      maxAge: maxAgeMs,
      path: '/',
      ...(domain ? { domain } : {}),
    });
  }

  private setRefreshTokenCookie(res: Response, token: string): void {
    const domain = this.cookieDomain();
    res.cookie(this.refreshTokenCookieName(), token, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: this.refreshTokenSameSite(),
      maxAge: this.refreshTokenTtlSeconds() * 1000,
      path: this.refreshCookiePath(),
      ...(domain ? { domain } : {}),
    });
  }
}
