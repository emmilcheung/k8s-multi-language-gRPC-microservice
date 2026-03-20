import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { SignupDto, SigninDto } from './auth.dto';

@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  // POST /api/users/signup
  @Post('api/users/signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const token = await this.authService.signup(dto.email, dto.password);
    this.setTokenCookie(res, token);
    return { currentUser: { email: dto.email } };
  }

  // POST /api/users/signin
  @Post('api/users/signin')
  @HttpCode(HttpStatus.OK)
  async signin(@Body() dto: SigninDto, @Res({ passthrough: true }) res: Response) {
    const token = await this.authService.signin(dto.email, dto.password);
    this.setTokenCookie(res, token);
    return { currentUser: { email: dto.email } };
  }

  // POST /api/users/signout
  @Post('api/users/signout')
  @HttpCode(HttpStatus.NO_CONTENT)
  signout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('token');
  }

  // GET /api/users/currentuser
  // Kong injects X-User-Id after JWT verification; this endpoint reads that header
  @Get('api/users/currentuser')
  @HttpCode(HttpStatus.OK)
  currentUser(@Req() req: Request) {
    const userId = req.headers['x-user-id'] as string | undefined;
    if (!userId) {
      return { currentUser: null };
    }
    return { currentUser: { id: userId } };
  }

  // GET /.well-known/jwks.json — public key endpoint consumed by Kong
  @Get('.well-known/jwks.json')
  @HttpCode(HttpStatus.OK)
  jwks() {
    return this.authService.getJwks();
  }

  private setTokenCookie(res: Response, token: string) {
    res.cookie('token', token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT expiry
    });
  }
}
