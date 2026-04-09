import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import ms from 'ms';
import { AuthService } from './auth.service';
import { SignupDto, SigninDto } from './auth.dto';
import { RefreshTokenService } from './refresh-token.service';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'token';
const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_REFRESH_COOKIE_PATH = '/';

@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly config: ConfigService,
  ) {}

  // POST /api/users/signup
  @Post('api/users/signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.signup(
      dto.email,
      dto.password,
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.signin(
      dto.email,
      dto.password,
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

    // Validate — throws 401 if missing or expired
    const userId = await this.refreshTokenService.validate(oldRefreshToken);

    // Rotate: delete old token before issuing the new one
    await this.refreshTokenService.revoke(oldRefreshToken);

    const [accessToken, refreshToken] = await Promise.all([
      this.authService.issueAccessTokenForUser(userId),
      this.refreshTokenService.issue(userId),
    ]);

    this.setAccessTokenCookie(res, accessToken);
    this.setRefreshTokenCookie(res, refreshToken);
    return {};
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
