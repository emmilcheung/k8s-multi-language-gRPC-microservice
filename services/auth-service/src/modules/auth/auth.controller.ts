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

// Cookie names
const ACCESS_TOKEN_COOKIE = 'token';
const REFRESH_TOKEN_COOKIE = 'refreshToken';

// Refresh token TTL in ms (7 days — must match Redis TTL in RefreshTokenService)
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
    const oldRefreshToken = req.cookies[REFRESH_TOKEN_COOKIE] as
      | string
      | undefined;
    if (oldRefreshToken) {
      // Best-effort revocation — don't throw if the token is already gone
      await this.refreshTokenService.revoke(oldRefreshToken).catch(() => {});
    }

    // Blacklist the access token so it cannot be reused before it naturally
    // expires. This is a defence-in-depth measure — the primary defence is the
    // short (15 min) token lifetime (S-04).
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE] as string | undefined;
    if (accessToken) {
      await this.authService.blacklistAccessToken(accessToken);
    }

    res.clearCookie(ACCESS_TOKEN_COOKIE);
    res.clearCookie(REFRESH_TOKEN_COOKIE);
  }

  // POST /api/auth/refresh — rotate refresh token and issue new access token
  @Post('api/auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const oldRefreshToken = req.cookies[REFRESH_TOKEN_COOKIE] as
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
    const token = req.cookies['token'] as string | undefined;

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

  private setAccessTokenCookie(res: Response, token: string): void {
    // Derive maxAge from JWT_EXPIRY config so cookie lifetime stays in sync
    // with the token's actual validity window (S-06).
    const expiry = this.config.get<string>('JWT_EXPIRY', '15m');
    const maxAgeMs = ms(expiry as Parameters<typeof ms>[0]) ?? 15 * 60 * 1000;
    res.cookie(ACCESS_TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'strict',
      maxAge: maxAgeMs,
    });
  }

  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie(REFRESH_TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      // Scope refresh cookie to the refresh endpoint only — prevents it being
      // sent on every API request and limits exposure surface.
      path: '/api/auth/refresh',
    });
  }
}
