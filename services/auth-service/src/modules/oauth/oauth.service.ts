import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { UsersRepository } from '../users/users.repository';
import { OAuthCodeStoreService } from './oauth-code-store.service';
import { findClient, validateScopes } from './oauth-clients.config';
import { verifyPkceChallenge } from './pkce.util';
import type {
  AuthorizeQuery,
  TokenBody,
  RevokeBody,
  TokenResponse,
  OAuthClientSession,
} from './oauth.dto';

@Injectable()
export class OAuthService {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly usersRepo: UsersRepository,
    private readonly codeStore: OAuthCodeStoreService,
    private readonly config: ConfigService,
  ) {}

  /**
   * GET /oauth/authorize
   * Validates the request, checks user is authenticated (via cookie),
   * and auto-approves for the first-party ticketing-mcp client.
   * Returns a redirect URL.
   */
  async authorize(
    query: AuthorizeQuery,
    req: Request,
  ): Promise<{ redirectUrl: string }> {
    // 1. Validate required params
    if (query.response_type !== 'code') {
      throw new BadRequestException({
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported',
      });
    }
    if (!query.code_challenge || query.code_challenge_method !== 'S256') {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'code_challenge with method=S256 is required',
      });
    }

    // 2. Validate client
    const client = findClient(query.client_id);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }
    if (!client.redirectUris.includes(query.redirect_uri)) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered for this client',
      });
    }

    // 3. Check user is authenticated via access token cookie
    const cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'token');
    const accessToken: string | undefined = (
      req.cookies as Record<string, string>
    )[cookieName];

    if (!accessToken) {
      // Not authenticated — redirect to signin, preserving the full authorize URL
      const next = encodeURIComponent(req.originalUrl);
      return { redirectUrl: `/auth/signin?next=${next}` };
    }

    let userId: string;
    try {
      const payload = await this.authService.verifyAccessToken(accessToken);
      userId = payload.sub;
    } catch {
      const next = encodeURIComponent(req.originalUrl);
      return { redirectUrl: `/auth/signin?next=${next}` };
    }

    // 4. Parse and validate requested scopes
    const requestedScopes = query.scope
      ? query.scope.split(' ').filter(Boolean)
      : [...client.allowedScopes];
    const grantedScopes = validateScopes(requestedScopes, client);
    if (grantedScopes.length === 0) {
      throw new BadRequestException({
        error: 'invalid_scope',
        error_description:
          'None of the requested scopes are allowed for this client',
      });
    }

    // 5. Issue authorization code (auto-approve for first-party client)
    const code = await this.codeStore.storeCode({
      clientId: client.clientId,
      userId,
      scope: grantedScopes.join(' '),
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      redirectUri: query.redirect_uri,
    });

    // 6. Redirect to client with code + state
    const redirectUrl = new URL(query.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (query.state) redirectUrl.searchParams.set('state', query.state);

    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * POST /oauth/token
   * Handles authorization_code and refresh_token grant types.
   */
  async token(body: TokenBody, req: Request): Promise<TokenResponse> {
    if (body.grant_type === 'authorization_code') {
      return this.exchangeAuthorizationCode(body, req);
    }
    if (body.grant_type === 'refresh_token') {
      return this.refreshTokenGrant(body, req);
    }
    throw new BadRequestException({
      error: 'unsupported_grant_type',
      error_description:
        'Supported grant types: authorization_code, refresh_token',
    });
  }

  private async exchangeAuthorizationCode(
    body: TokenBody,
    req: Request,
  ): Promise<TokenResponse> {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'code, code_verifier, and redirect_uri are required',
      });
    }

    const client = findClient(body.client_id);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }

    // Consume the code (single-use — deleted from Redis on read)
    const record = await this.codeStore.consumeCode(body.code);
    if (!record) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'Authorization code is invalid or expired',
      });
    }

    if (record.clientId !== body.client_id) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'client_id mismatch',
      });
    }
    if (record.redirectUri !== body.redirect_uri) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'redirect_uri mismatch',
      });
    }

    // Verify PKCE
    if (
      !verifyPkceChallenge(
        body.code_verifier,
        record.codeChallenge,
        record.codeChallengeMethod,
      )
    ) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      });
    }

    // Look up user
    const user = await this.usersRepo.findById(record.userId);
    if (!user) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'User not found',
      });
    }

    // Issue tokens
    const accessToken = this.authService.issueAccessTokenForOAuth(
      user.id,
      user.email,
      record.scope,
      client.clientId,
    );

    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = req.headers['user-agent'] ?? null;
    const rawRefreshToken = await this.refreshTokenService.issue(user.id, {
      ipAddress,
      userAgent,
    });

    // Store scope metadata alongside the session for future refresh_token grants
    const sessionId =
      this.refreshTokenService.extractSessionId(rawRefreshToken);
    if (sessionId) {
      await this.codeStore.storeSessionScope(
        sessionId,
        { scope: record.scope, clientId: client.clientId },
        client.refreshTokenLifetimeSeconds,
      );
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: client.accessTokenLifetimeSeconds,
      scope: record.scope,
      refresh_token: rawRefreshToken,
    };
  }

  private async refreshTokenGrant(
    body: TokenBody,
    req: Request,
  ): Promise<TokenResponse> {
    if (!body.refresh_token) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      });
    }

    const client = findClient(body.client_id);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }

    // Rotate the refresh token
    let userId: string;
    let newRefreshToken: string;
    let sessionId: string;
    try {
      const result = await this.refreshTokenService.rotate(body.refresh_token, {
        ipAddress:
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
          req.ip ??
          null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      userId = result.userId;
      newRefreshToken = result.refreshToken;
      sessionId = result.sessionId;
    } catch {
      throw new UnauthorizedException({
        error: 'invalid_grant',
        error_description: 'Refresh token is invalid or expired',
      });
    }

    // Retrieve scope from session metadata
    const scopeMeta = await this.codeStore.getSessionScope(sessionId);
    if (!scopeMeta || scopeMeta.clientId !== body.client_id) {
      // Session exists but has no OAuth scope (it's a browser session, not an OAuth session)
      throw new UnauthorizedException({
        error: 'invalid_grant',
        error_description: 'Refresh token was not issued to this client',
      });
    }

    // Look up user for email claim
    const user = await this.usersRepo.findById(userId);
    if (!user) {
      throw new BadRequestException({
        error: 'invalid_grant',
        error_description: 'User not found',
      });
    }

    // Re-store scope with refreshed TTL
    await this.codeStore.storeSessionScope(
      sessionId,
      { scope: scopeMeta.scope, clientId: client.clientId },
      client.refreshTokenLifetimeSeconds,
    );

    const accessToken = this.authService.issueAccessTokenForOAuth(
      user.id,
      user.email,
      scopeMeta.scope,
      client.clientId,
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: client.accessTokenLifetimeSeconds,
      scope: scopeMeta.scope,
      refresh_token: newRefreshToken,
    };
  }

  /** POST /oauth/revoke — revoke a refresh token */
  async revoke(body: RevokeBody): Promise<void> {
    if (!body.token) return; // Per RFC 7009: always return 200 even if token is invalid

    const sessionId = this.refreshTokenService.extractSessionId(body.token);
    if (sessionId) {
      await this.codeStore.deleteSessionScope(sessionId);
    }
    await this.refreshTokenService.revoke(body.token);
  }

  /** GET /oauth/clients — list OAuth sessions for the authenticated user */
  async listClients(userId: string): Promise<OAuthClientSession[]> {
    const sessions = await this.refreshTokenService.listSessions(userId);
    const results: OAuthClientSession[] = [];

    await Promise.all(
      sessions.map(async (session) => {
        const scopeMeta = await this.codeStore.getSessionScope(
          session.sessionId,
        );
        if (!scopeMeta) return; // Not an OAuth session — skip

        const client = findClient(scopeMeta.clientId);
        results.push({
          clientId: scopeMeta.clientId,
          clientName: client?.clientName ?? scopeMeta.clientId,
          scope: scopeMeta.scope,
          sessionId: session.sessionId,
          lastRotatedAt: session.lastRotatedAt,
        });
      }),
    );

    return results.sort((a, b) =>
      b.lastRotatedAt.localeCompare(a.lastRotatedAt),
    );
  }

  /** DELETE /oauth/clients/:clientId — revoke all sessions for a given client */
  async revokeClient(userId: string, clientId: string): Promise<void> {
    const sessions = await this.refreshTokenService.listSessions(userId);

    await Promise.all(
      sessions.map(async (session) => {
        const scopeMeta = await this.codeStore.getSessionScope(
          session.sessionId,
        );
        if (!scopeMeta || scopeMeta.clientId !== clientId) return;

        await Promise.all([
          this.refreshTokenService.revokeSession(userId, session.sessionId),
          this.codeStore.deleteSessionScope(session.sessionId),
        ]);
      }),
    );
  }
}
