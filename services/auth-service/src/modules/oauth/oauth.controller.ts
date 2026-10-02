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
  BadRequestException,
  UnauthorizedException,
  UseFilters,
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
  ClientCredentials,
  RegisterClientResponse,
  ConsentDetails,
  ConsentResult,
} from './oauth.dto';
import { TOKEN_EXCHANGE_GRANT } from './oauth-clients.config';
import { UserIdSignatureValidator } from '../../common/security/user-id-signature.validator';
import {
  OAuthExceptionFilter,
  OAuthRegistrationExceptionFilter,
} from './oauth-exception.filter';

/** RFC 6749 §2.3.1: form-urlencoded, so `+` is a space. */
const formDecode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));

/**
 * RFC 6749 §2.3.1 client_secret_basic. No header means no Basic credentials;
 * a Basic header that cannot be decoded is a failed authentication (401), not
 * something to ignore, so a broken client does not silently fall back.
 */
function parseBasicCredentials(
  header: string | undefined,
): ClientCredentials | undefined {
  if (!header || !/^basic\s/i.test(header)) return undefined;
  const invalid = () =>
    new UnauthorizedException({
      error: 'invalid_client',
      error_description: 'Malformed Authorization header',
    });
  const encoded = header.slice(6).trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw invalid();
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 1) throw invalid();
  try {
    return {
      clientId: formDecode(decoded.slice(0, sep)),
      clientSecret: formDecode(decoded.slice(sep + 1)),
    };
  } catch {
    throw invalid();
  }
}

@Controller()
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly signatureValidator: UserIdSignatureValidator,
  ) {}

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
  @UseFilters(OAuthExceptionFilter)
  async token(@Body() body: TokenBody, @Req() req: Request) {
    // Basic credentials only matter for the confidential token-exchange grant;
    // public-client grants ignore the header exactly as before.
    const basic =
      body.grant_type === TOKEN_EXCHANGE_GRANT
        ? parseBasicCredentials(req.headers.authorization)
        : undefined;
    return this.oauthService.token(body, req, basic);
  }

  // POST /oauth/revoke
  @Post('oauth/revoke')
  @HttpCode(HttpStatus.OK)
  @UseFilters(OAuthExceptionFilter)
  async revoke(@Body() body: RevokeBody): Promise<{ ok: boolean }> {
    await this.oauthService.revoke(body);
    return { ok: true };
  }

  // GET /oauth/clients — X-User-Id injected by Kong after JWT validation
  // X-User-Id-Sig must be valid
  @Get('oauth/clients')
  async listClients(@Req() req: Request) {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    const userIdSig =
      (req.headers['x-user-id-sig'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    if (!this.signatureValidator.isValidSignature(userId, userIdSig)) {
      throw new UnauthorizedException('invalid X-User-Id-Sig signature');
    }
    return this.oauthService.listClients(userId);
  }

  // DELETE /oauth/clients?client_id=<id> — the form for URL (CIMD) client ids,
  // which contain ':' and '/' and must not sit in a path segment behind a proxy.
  @Delete('oauth/clients')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeClientByQuery(
    @Query('client_id') clientId: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const userId = this.verifiedUserId(req);
    if (
      typeof clientId !== 'string' ||
      clientId.length === 0 ||
      clientId.length > 512
    ) {
      throw new BadRequestException('client_id is required');
    }
    await this.oauthService.revokeClient(userId, clientId);
  }

  // DELETE /oauth/clients/:clientId — original form, kept for opaque ids
  @Delete('oauth/clients/:clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeClient(
    @Param('clientId') clientId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.oauthService.revokeClient(this.verifiedUserId(req), clientId);
  }

  private verifiedUserId(req: Request): string {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    const userIdSig =
      (req.headers['x-user-id-sig'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    if (!this.signatureValidator.isValidSignature(userId, userIdSig)) {
      throw new UnauthorizedException('invalid X-User-Id-Sig signature');
    }
    return userId;
  }

  // POST /oauth/clients/register — RFC 7591 dynamic client registration (public, no JWT)
  @Post('oauth/clients/register')
  @HttpCode(HttpStatus.CREATED)
  @UseFilters(OAuthRegistrationExceptionFilter)
  async register(
    @Body() body: RegisterClientBody,
  ): Promise<RegisterClientResponse> {
    return this.oauthService.registerClient(body);
  }

  // GET /oauth/consent/:requestId — JWT protected (X-User-Id injected by Kong)
  // X-User-Id-Sig must be valid
  @Get('oauth/consent/:requestId')
  async getConsent(
    @Param('requestId') requestId: string,
    @Req() req: Request,
  ): Promise<ConsentDetails> {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    const userIdSig =
      (req.headers['x-user-id-sig'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    if (!this.signatureValidator.isValidSignature(userId, userIdSig)) {
      throw new UnauthorizedException('invalid X-User-Id-Sig signature');
    }
    return this.oauthService.getConsentRequest(requestId, userId);
  }

  // POST /oauth/consent/:requestId — JWT protected (X-User-Id injected by Kong)
  // X-User-Id-Sig must be valid
  @Post('oauth/consent/:requestId')
  @HttpCode(HttpStatus.OK)
  async submitConsent(
    @Param('requestId') requestId: string,
    @Body() body: ConsentBody,
    @Req() req: Request,
  ): Promise<ConsentResult> {
    const userId =
      (req.headers['x-user-id'] as string | undefined) ?? undefined;
    const userIdSig =
      (req.headers['x-user-id-sig'] as string | undefined) ?? undefined;
    if (!userId) throw new ForbiddenException();
    if (!this.signatureValidator.isValidSignature(userId, userIdSig)) {
      throw new UnauthorizedException('invalid X-User-Id-Sig signature');
    }
    return this.oauthService.submitConsent(requestId, userId, body.approve);
  }
}
