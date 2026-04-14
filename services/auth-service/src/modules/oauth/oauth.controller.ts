import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Param,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { OAuthService } from './oauth.service';
import {
  AuthorizeQuery,
  TokenBody,
  RevokeBody,
  RegisterClientBody,
  ConsentBody,
} from './oauth.dto';
import type {
  RegisterClientResponse,
  ConsentDetails,
  ConsentResult,
} from './oauth.dto';

@Controller()
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  // GET /oauth/authorize
  @Get('oauth/authorize')
  async authorize(
    @Query() query: AuthorizeQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl } = await this.oauthService.authorize(query, req);
    res.redirect(302, redirectUrl);
  }

  // POST /oauth/token
  @Post('oauth/token')
  @HttpCode(HttpStatus.OK)
  async token(@Body() body: TokenBody, @Req() req: Request) {
    return this.oauthService.token(body, req);
  }

  // POST /oauth/revoke
  @Post('oauth/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Body() body: RevokeBody): Promise<{ ok: boolean }> {
    await this.oauthService.revoke(body);
    return { ok: true };
  }

  // GET /oauth/clients — X-User-Id injected by Kong after JWT validation
  @Get('oauth/clients')
  async listClients(@Req() req: Request) {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    return this.oauthService.listClients(userId);
  }

  // DELETE /oauth/clients/:clientId
  @Delete('oauth/clients/:clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeClient(
    @Param('clientId') clientId: string,
    @Req() req: Request,
  ): Promise<void> {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    await this.oauthService.revokeClient(userId, clientId);
  }

  // POST /oauth/clients/register — RFC 7591 dynamic client registration (public, no JWT)
  @Post('oauth/clients/register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: RegisterClientBody,
  ): Promise<RegisterClientResponse> {
    return this.oauthService.registerClient(body);
  }

  // GET /oauth/consent/:requestId — public; fetched by Next.js consent page to show client info
  @Get('oauth/consent/:requestId')
  async getConsent(
    @Param('requestId') requestId: string,
  ): Promise<ConsentDetails> {
    return this.oauthService.getConsentRequest(requestId);
  }

  // POST /oauth/consent/:requestId — JWT protected (X-User-Id injected by Kong)
  @Post('oauth/consent/:requestId')
  @HttpCode(HttpStatus.OK)
  async submitConsent(
    @Param('requestId') requestId: string,
    @Body() body: ConsentBody,
    @Req() req: Request,
  ): Promise<ConsentResult> {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    return this.oauthService.submitConsent(requestId, userId, body.approve);
  }
}
