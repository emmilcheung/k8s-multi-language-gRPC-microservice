import {
  Injectable,
  OnModuleInit,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { UsersRepository } from '../users/users.repository';
import { OAuthCodeStoreService } from './oauth-code-store.service';
import {
  findClient,
  validateScopes,
  dynamicToStaticShape,
  describeClientAddresses,
  isUrlClientId,
  MCP_SERVICE_CLIENT_ID,
  TOKEN_EXCHANGE_GRANT,
} from './oauth-clients.config';
import type { OAuthClient } from './oauth-clients.config';
import { DynamicClientService } from './dynamic-client.service';
import { CimdClientService } from './cimd-client.service';
import { OAuthTemporarilyUnavailableException } from './oauth-unavailable';
import { OAuthConsentStoreService } from './oauth-consent-store.service';
import type { ConsentSummary } from './oauth-consent-store.service';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import { verifyPkceChallenge } from './pkce.util';
import { redirectUriMatches } from './oauth-redirect.util';
import {
  readOAuthConfig,
  readTokenExchangeSecretHash,
  resolveOAuthTokenIssuer,
} from './oauth-config';
import type {
  AuthorizeQuery,
  TokenBody,
  RevokeBody,
  TokenResponse,
  TokenExchangeResponse,
  ClientCredentials,
  OAuthClientSession,
  RegisterClientBody,
  RegisterClientResponse,
} from './oauth.dto';

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
/** C-1: an exchanged token lives at most this long (and never past its subject). */
const EXCHANGED_TOKEN_MAX_SECONDS = 300;

const TRANSIENT_CIMD_REASONS: ReadonlySet<string> = new Set([
  'timeout',
  'connect_failed',
  'dns_unavailable',
]);

@Injectable()
export class OAuthService implements OnModuleInit {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly usersRepo: UsersRepository,
    private readonly codeStore: OAuthCodeStoreService,
    private readonly config: ConfigService,
    private readonly dynamicClientService: DynamicClientService,
    private readonly consentStore: OAuthConsentStoreService,
    @InjectPinoLogger(OAuthService.name) private readonly logger: PinoLogger,
    private readonly cimd: CimdClientService,
  ) {}

  onModuleInit(): void {
    if (!readTokenExchangeSecretHash(this.config)) {
      this.logger.warn(
        'MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH is not set: the token-exchange grant is disabled (mcp-service cannot authenticate)',
      );
    }
  }

  /**
   * Resolve a client by ID. A URL-shaped id is a Client ID Metadata Document
   * (cached, or fetched under the SSRF guard) and never touches the opaque-id
   * stores; any other id checks the static registry, then the dynamic Redis store.
   */
  async resolveClient(clientId: string): Promise<OAuthClient | null> {
    if (isUrlClientId(clientId)) {
      const r = await this.cimd.resolve(clientId);
      return r.ok ? r.client : null;
    }
    const staticClient = findClient(clientId);
    if (staticClient) return staticClient;
    const dynamic = await this.dynamicClientService.findClient(clientId);
    return dynamic ? dynamicToStaticShape(dynamic) : null;
  }

  /**
   * Client lookup for authorize/token/refresh. A transient CIMD failure is a
   * retryable 503, not a terminal unknown client: a refreshing client must not
   * discard its credentials because a document host blipped. Blocked addresses,
   * bad shapes and bad documents never take this path, so it is no oracle.
   */
  private async resolveClientForRequest(
    clientId: string,
  ): Promise<OAuthClient | null> {
    if (!isUrlClientId(clientId)) return this.resolveClient(clientId);
    const r = await this.cimd.resolve(clientId);
    if (r.ok) return r.client;
    if (r.reason === 'busy') throw new OAuthTemporarilyUnavailableException(5);
    if (TRANSIENT_CIMD_REASONS.has(r.reason)) {
      // The failure is negatively cached for 60 s, so retrying sooner cannot help.
      throw new OAuthTemporarilyUnavailableException(60);
    }
    return null;
  }

  /**
   * /authorize is reachable without a session, and a CIMD client id costs an
   * outbound fetch, so everything that can be checked without the client is
   * checked first. Failure detail stays in the logs: telling the caller why a
   * fetch failed (blocked address vs DNS vs timeout) would be an SSRF oracle.
   */
  private async resolveAuthorizeClient(
    query: AuthorizeQuery,
  ): Promise<OAuthClient | null> {
    if (!isUrlClientId(query.client_id)) {
      return this.resolveClient(query.client_id);
    }
    this.assertAllowedResource(query.resource);
    const client = await this.resolveClientForRequest(query.client_id);
    if (client) return client;
    if (!this.cimd.enabled) return null;
    throw new BadRequestException({
      error: 'invalid_client',
      error_description:
        'client_id metadata document could not be retrieved or is not valid',
    });
  }

  /** RFC 8707 / C-2: a resource must be an exact member of OAUTH_RESOURCES. */
  private assertAllowedResource(resource: string | undefined): void {
    if (
      resource !== undefined &&
      !readOAuthConfig(this.config).resources.includes(resource)
    ) {
      throw new BadRequestException({
        error: 'invalid_target',
        error_description: 'resource is not a recognised resource server',
      });
    }
  }

  /** Every token audience and issuer decision is made here (C-1, D3). */
  private mintAccessToken(
    userId: string,
    scope: string,
    clientId: string,
    resource: string | undefined,
  ): string {
    const cfg = readOAuthConfig(this.config);
    return this.authService.issueAccessTokenForOAuth(userId, scope, clientId, {
      aud: resource ?? cfg.apiAudience,
      iss: resolveOAuthTokenIssuer(cfg),
    });
  }

  /** RFC 9207: tell the client which AS produced this authorization response. */
  private withIssuer(url: URL): URL {
    url.searchParams.set('iss', readOAuthConfig(this.config).issuer);
    return url;
  }

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
    const client = await this.resolveAuthorizeClient(query);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }
    if (!redirectUriMatches(client.redirectUris, query.redirect_uri)) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered for this client',
      });
    }
    this.assertAllowedResource(query.resource);

    // 3. Check user is authenticated via access token cookie
    const cookieName = this.config.get<string>('JWT_COOKIE_NAME', 'token');
    const accessToken: string | undefined = (
      req.cookies as Record<string, string>
    )[cookieName];

    // Build an absolute authorize URL so the browser can return here after login.
    // KONG_BASE_URL is the external-facing Kong proxy URL (e.g. http://localhost:8000).
    // OAUTH_CLIENT_BASE_URL is the Next.js client (e.g. http://localhost:4000).
    const kongBase = this.config.get<string>(
      'KONG_BASE_URL',
      'http://localhost:8000',
    );
    const clientBase = this.config.get<string>(
      'OAUTH_CLIENT_BASE_URL',
      'http://localhost:4000',
    );
    const absoluteAuthorizeUrl = `${kongBase}${req.originalUrl}`;

    if (!accessToken) {
      const next = encodeURIComponent(absoluteAuthorizeUrl);
      return { redirectUrl: `${clientBase}/auth/signin?next=${next}` };
    }

    let userId: string;
    try {
      const payload =
        await this.authService.verifySessionAccessToken(accessToken);
      userId = payload.sub;
    } catch {
      const next = encodeURIComponent(absoluteAuthorizeUrl);
      return { redirectUrl: `${clientBase}/auth/signin?next=${next}` };
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

    // 5. Only clients explicitly marked isFirstParty:true are auto-approved.
    // All others (including undefined) require explicit user consent.
    if (client.isFirstParty !== true) {
      // Dynamic (third-party) client — store pending consent and redirect to consent UI
      const requestId = await this.consentStore.storePendingConsent({
        clientId: client.clientId,
        clientName: client.clientName,
        addresses: describeClientAddresses(
          client.clientId,
          client,
          query.redirect_uri,
        ),
        isFirstParty: client.source === undefined,
        userId,
        scope: grantedScopes.join(' '),
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        state: query.state,
        resource: query.resource,
      });
      return {
        redirectUrl: `${clientBase}/oauth/consent?request_id=${requestId}`,
      };
    }

    // 6. Auto-approve: issue authorization code immediately
    const code = await this.codeStore.storeCode({
      clientId: client.clientId,
      userId,
      scope: grantedScopes.join(' '),
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      redirectUri: query.redirect_uri,
      resource: query.resource,
    });

    // 7. Redirect to client with code + state + iss
    const redirectUrl = this.withIssuer(new URL(query.redirect_uri));
    redirectUrl.searchParams.set('code', code);
    if (query.state) redirectUrl.searchParams.set('state', query.state);

    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * POST /oauth/token
   * Handles authorization_code and refresh_token grant types.
   */
  async token(
    body: TokenBody,
    req: Request,
    basic?: ClientCredentials,
  ): Promise<TokenResponse | TokenExchangeResponse> {
    if (body.grant_type === TOKEN_EXCHANGE_GRANT) {
      return this.tokenExchange(body, basic);
    }
    if (
      body.grant_type !== 'authorization_code' &&
      body.grant_type !== 'refresh_token'
    ) {
      throw new BadRequestException({
        error: 'unsupported_grant_type',
        error_description:
          'Supported grant types: authorization_code, refresh_token, urn:ietf:params:oauth:grant-type:token-exchange',
      });
    }
    if (!body.client_id) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'client_id is required',
      });
    }
    const withClient = body as TokenBody & { client_id: string };
    return body.grant_type === 'authorization_code'
      ? this.exchangeAuthorizationCode(withClient, req)
      : this.refreshTokenGrant(withClient, req);
  }

  /**
   * RFC 8693 token exchange (C-5). mcp-service trades the user's MCP-audience
   * token for a short-lived API-audience token that keeps the ORIGINAL client
   * id and can only narrow scope. Client authentication happens first so an
   * unauthenticated caller learns nothing about the subject token.
   *
   * Known limit (accepted): revoking a connected app does not block exchange of
   * an MCP access token already issued; it stays exchangeable until it expires
   * (<= 15 min, as for any access token). Exchanged tokens live <= 5 min and
   * never past the subject's exp. Only the jti blacklist and user deletion
   * block exchange.
   */
  private async tokenExchange(
    body: TokenBody,
    basic: ClientCredentials | undefined,
  ): Promise<TokenExchangeResponse> {
    await this.authenticateExchangeClient(body, basic);

    if (!body.subject_token || body.subject_token_type !== ACCESS_TOKEN_TYPE) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: `subject_token and subject_token_type=${ACCESS_TOKEN_TYPE} are required`,
      });
    }

    const cfg = readOAuthConfig(this.config);
    if (
      body.resource !== undefined &&
      body.audience !== undefined &&
      body.resource !== body.audience
    ) {
      throw new BadRequestException({
        error: 'invalid_target',
        error_description: 'resource and audience disagree',
      });
    }
    const target = body.resource ?? body.audience ?? cfg.apiAudience;
    if (target !== cfg.apiAudience) {
      throw new BadRequestException({
        error: 'invalid_target',
        error_description: 'the only exchange target is the API audience',
      });
    }

    const invalidSubject = () =>
      new BadRequestException({
        error: 'invalid_grant',
        error_description: 'subject_token is invalid or not exchangeable',
      });
    let subject;
    try {
      subject = await this.authService.verifyOAuthSubjectToken(
        body.subject_token,
      );
    } catch {
      throw invalidSubject();
    }
    const audiences = Array.isArray(subject.aud) ? subject.aud : [subject.aud];
    if (audiences.length !== 1 || audiences[0] !== cfg.mcpResource) {
      throw invalidSubject();
    }
    // One clock read: expiry check and minting share it, so a tick in between
    // cannot leave a zero or negative lifetime.
    const iat = Math.floor(Date.now() / 1000);
    const exp = Math.min(iat + EXCHANGED_TOKEN_MAX_SECONDS, subject.exp);
    const expiresIn = exp - iat;
    if (expiresIn <= 0 || !(await this.usersRepo.findById(subject.sub))) {
      throw invalidSubject();
    }

    const subjectScopes = subject.scope.split(' ').filter(Boolean);
    let granted = subjectScopes;
    if (body.scope !== undefined) {
      granted = [...new Set(body.scope.split(' ').filter(Boolean))];
      if (
        granted.length === 0 ||
        !granted.every((s) => subjectScopes.includes(s))
      ) {
        throw new BadRequestException({
          error: 'invalid_scope',
          error_description: 'requested scope exceeds the subject token scope',
        });
      }
    }
    const scope = granted.join(' ');

    const accessToken = this.authService.issueAccessTokenForOAuth(
      subject.sub,
      scope,
      subject.client_id,
      {
        aud: cfg.apiAudience,
        iss: resolveOAuthTokenIssuer(cfg),
        act: { sub: MCP_SERVICE_CLIENT_ID },
        iat,
        exp,
      },
    );

    // Audit: identifiers and scope only, never a token or the client secret.
    this.logger.info(
      {
        event: 'oauth.token.exchanged',
        clientId: MCP_SERVICE_CLIENT_ID,
        originalClientId: subject.client_id,
        userId: subject.sub,
        scope,
      },
      'OAuth audit event',
    );

    return {
      access_token: accessToken,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope,
    };
  }

  /**
   * Only the confidential mcp-service client may exchange, and only with its
   * client_secret_basic secret. Basic-auth failures are 401 (RFC 6749 §5.2);
   * the secret is machine-generated and high-entropy, so SHA-256 plus a
   * constant-time compare suffices (a slow hash on this public endpoint would
   * only be a CPU lever for attackers). With no configured hash nobody can
   * authenticate, which is how the grant is disabled.
   */
  private async authenticateExchangeClient(
    body: TokenBody,
    basic: ClientCredentials | undefined,
  ): Promise<void> {
    const clientId = basic?.clientId ?? body.client_id;
    const failed = () =>
      new UnauthorizedException({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    if (!clientId) throw failed();
    if (
      basic &&
      body.client_id !== undefined &&
      body.client_id !== basic.clientId
    ) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'client_id does not match the Authorization header',
      });
    }

    if (clientId !== MCP_SERVICE_CLIENT_ID) {
      // Only the confidential mcp-service client may exchange, so a URL id
      // is refused as an unknown client BEFORE any resolve: this grant can then
      // neither trigger a fetch nor reveal whether a document exists.
      if (isUrlClientId(clientId) || !(await this.resolveClient(clientId))) {
        throw basic
          ? failed()
          : new BadRequestException({
              error: 'invalid_client',
              error_description: 'Unknown client_id',
            });
      }
      throw new BadRequestException({
        error: 'unauthorized_client',
        error_description: 'This client may not use the token-exchange grant',
      });
    }

    const hash = readTokenExchangeSecretHash(this.config);
    let authenticated = false;
    if (hash && basic) {
      const presented = createHash('sha256')
        .update(basic.clientSecret)
        .digest();
      authenticated = timingSafeEqual(presented, Buffer.from(hash, 'hex'));
    }
    if (!authenticated) throw failed();
  }

  private async exchangeAuthorizationCode(
    body: TokenBody & { client_id: string },
    req: Request,
  ): Promise<TokenResponse> {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'code, code_verifier, and redirect_uri are required',
      });
    }

    const client = await this.resolveClientForRequest(body.client_id);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }

    // Reject an unknown resource before the code is consumed (RFC 8707).
    this.assertAllowedResource(body.resource);

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

    // RFC 8707 §2: the token request may not name a different resource than
    // the authorization request did (none at authorize means the default).
    if (body.resource !== undefined && body.resource !== record.resource) {
      throw new BadRequestException({
        error: 'invalid_target',
        error_description: 'resource does not match the authorization request',
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
    const accessToken = this.mintAccessToken(
      user.id,
      record.scope,
      client.clientId,
      record.resource,
    );

    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = req.headers['user-agent'] ?? null;
    const rawRefreshToken = await this.refreshTokenService.issue(
      user.id,
      { ipAddress, userAgent },
      client.clientId,
    );

    // Store scope metadata alongside the session for future refresh_token grants
    const sessionId =
      this.refreshTokenService.extractSessionId(rawRefreshToken);
    if (sessionId) {
      await this.codeStore.storeSessionScope(
        sessionId,
        {
          scope: record.scope,
          clientId: client.clientId,
          resource: record.resource,
        },
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
    body: TokenBody & { client_id: string },
    req: Request,
  ): Promise<TokenResponse> {
    if (!body.refresh_token) {
      throw new BadRequestException({
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      });
    }

    const client = await this.resolveClientForRequest(body.client_id);
    if (!client) {
      throw new BadRequestException({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }

    this.assertAllowedResource(body.resource);

    // A refresh may not switch audience. Same rule as the authorization_code
    // grant: an explicit resource must equal the one bound to the grant (none
    // bound means the default, which cannot be requested explicitly). Checked
    // before rotate() so a rejected mismatch does not burn the refresh token.
    // Only the client that owns the session is told about a mismatch; any other
    // caller falls through to rotate(), which rejects it as invalid_grant.
    if (body.resource !== undefined) {
      const sessionId = this.refreshTokenService.extractSessionId(
        body.refresh_token,
      );
      const bound = sessionId
        ? await this.codeStore.getSessionScope(sessionId)
        : null;
      if (
        bound &&
        bound.clientId === client.clientId &&
        body.resource !== bound.resource
      ) {
        throw new BadRequestException({
          error: 'invalid_target',
          error_description: 'resource does not match the original grant',
        });
      }
    }

    // Rotate the refresh token
    let userId: string;
    let newRefreshToken: string;
    let sessionId: string;
    try {
      const result = await this.refreshTokenService.rotate(
        body.refresh_token,
        {
          ipAddress:
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
            req.ip ??
            null,
          userAgent: req.headers['user-agent'] ?? null,
        },
        { kind: 'oauth', clientId: client.clientId },
      );
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
      // rotate() already proved the session belongs to this client; a missing marker means its scope TTL lapsed.
      throw new UnauthorizedException({
        error: 'invalid_grant',
        error_description: 'Refresh token was not issued to this client',
      });
    }

    // Confirm the user still exists
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
      {
        scope: scopeMeta.scope,
        clientId: client.clientId,
        resource: scopeMeta.resource,
      },
      client.refreshTokenLifetimeSeconds,
    );

    const accessToken = this.mintAccessToken(
      user.id,
      scopeMeta.scope,
      client.clientId,
      scopeMeta.resource,
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

        // Static registry first, then dynamic registrations (their id is a UUID,
        // so the registered name is what the Connected-apps page must show). A
        // CIMD id is looked up in the cache only: listing never fetches.
        const id = scopeMeta.clientId;
        const client = isUrlClientId(id)
          ? await this.cimd.peek(id)
          : await this.resolveClient(id);
        const addresses = describeClientAddresses(id, client);
        results.push({
          clientId: scopeMeta.clientId,
          clientName:
            client?.clientName ?? addresses.documentHost ?? scopeMeta.clientId,
          addresses,
          isFirstParty: client !== null && client.source === undefined,
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

  /** GET /oauth/consent/:requestId — return pending consent details for the UI, verifying the user owns it */
  async getConsentRequest(
    requestId: string,
    userId: string,
  ): Promise<ConsentSummary> {
    const record = await this.consentStore.getConsent(requestId);
    if (!record) {
      throw new NotFoundException({
        error: 'consent_request_not_found',
        error_description:
          'Consent request not found or expired. Please restart the authorization flow.',
      });
    }

    // User must be the one who initiated the authorize request
    if (record.userId !== userId) {
      throw new ForbiddenException({
        error: 'user_mismatch',
        error_description: 'You do not own this consent request.',
      });
    }

    return {
      requestId: record.requestId,
      clientId: record.clientId,
      clientName: record.clientName,
      addresses: record.addresses,
      isFirstParty: record.isFirstParty ?? false,
      scopes: record.scope.split(' ').filter(Boolean),
      expiresInSeconds: 600,
    };
  }

  /**
   * POST /oauth/consent/:requestId — user approves or denies the pending consent.
   * Must be called with a valid user session (cookie JWT validated by Kong).
   * Returns the redirect URL for the browser to follow.
   */
  async submitConsent(
    requestId: string,
    userId: string,
    approve: boolean,
  ): Promise<{ redirectUrl: string }> {
    const record = await this.consentStore.consumeConsent(requestId);
    if (!record) {
      throw new NotFoundException({
        error: 'consent_request_not_found',
        error_description:
          'Consent request not found or expired. Please restart the authorization flow.',
      });
    }

    // User must be the one who initiated the authorize request
    if (record.userId !== userId) {
      throw new ForbiddenException({ error: 'user_mismatch' });
    }

    if (!approve) {
      const denyUrl = this.withIssuer(new URL(record.redirectUri));
      denyUrl.searchParams.set('error', 'access_denied');
      denyUrl.searchParams.set(
        'error_description',
        'The user denied the authorization request.',
      );
      if (record.state) denyUrl.searchParams.set('state', record.state);
      return { redirectUrl: denyUrl.toString() };
    }

    // Issue the authorization code
    const code = await this.codeStore.storeCode({
      clientId: record.clientId,
      userId: record.userId,
      scope: record.scope,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      redirectUri: record.redirectUri,
      resource: record.resource,
    });

    const redirectUrl = this.withIssuer(new URL(record.redirectUri));
    redirectUrl.searchParams.set('code', code);
    if (record.state) redirectUrl.searchParams.set('state', record.state);
    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * POST /oauth/clients/register — RFC 7591 dynamic client registration (public client).
   * @deprecated DCR is the last of three registration paths (pre-registered,
   * Client ID Metadata Document, DCR). It stays for hosts that have no CIMD
   * support; new integrations should publish a metadata document instead.
   */
  async registerClient(
    body: RegisterClientBody,
  ): Promise<RegisterClientResponse> {
    const requestedScopes = body.scope
      ? body.scope.split(' ').filter(Boolean)
      : [...OAUTH_SCOPE_NAMES];

    const client = await this.dynamicClientService.register({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      scope: requestedScopes.join(' '),
      grantTypes: body.grant_types ?? ['authorization_code'],
      applicationType: body.application_type,
    });

    return {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      scope: client.allowedScopes.join(' '),
      token_endpoint_auth_method: 'none',
      application_type: client.applicationType ?? 'web',
      pkce_required: true,
    };
  }
}
