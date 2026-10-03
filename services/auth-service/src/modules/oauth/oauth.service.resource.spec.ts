import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OAuthService } from './oauth.service';
import { AuthorizeQuery, TokenBody } from './oauth.dto';

const MCP = 'http://localhost:8000/mcp';
const API = 'http://localhost:8000/api';
const CHALLENGE = 'x'.repeat(43);

function makeService(
  env: Record<string, unknown> = {},
  opts: { firstParty?: boolean } = {},
) {
  const authService = {
    verifySessionAccessToken: vi.fn().mockResolvedValue({ sub: 'user-1' }),
    issueAccessTokenForOAuth: vi.fn().mockReturnValue('access.jwt'),
  };
  const refreshTokenService = {
    issue: vi.fn().mockResolvedValue('sid.secret'),
    rotate: vi.fn().mockResolvedValue({
      userId: 'user-1',
      refreshToken: 'sid2.secret',
      sessionId: 'sid',
    }),
    extractSessionId: vi.fn().mockReturnValue('sid'),
  };
  const usersRepo = {
    findById: vi
      .fn()
      .mockResolvedValue({ id: 'user-1', email: 'u@example.com' }),
  };
  const codeStore = {
    storeCode: vi.fn().mockResolvedValue('the-code'),
    consumeCode: vi.fn(),
    storeSessionScope: vi.fn(),
    getSessionScope: vi.fn(),
  };
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => env[key] ?? fallback),
  };
  const dynamicClientService = {
    findClient: vi.fn().mockResolvedValue({
      clientId: 'dyn-1',
      clientName: 'Dyn',
      redirectUris: ['http://127.0.0.1:5000/cb'],
      grantTypes: ['authorization_code'],
      allowedScopes: ['tickets:read'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
    }),
  };
  const consentStore = {
    storePendingConsent: vi.fn().mockResolvedValue('req-1'),
    consumeConsent: vi.fn(),
  };
  const service = new OAuthService(
    authService as never,
    refreshTokenService as never,
    usersRepo as never,
    codeStore as never,
    config as never,
    dynamicClientService as never,
    consentStore as never,
    { info: vi.fn(), warn: vi.fn() } as never,
    {
      resolve: vi.fn().mockResolvedValue({ ok: false, reason: 'disabled' }),
      peek: vi.fn().mockResolvedValue(null),
    } as never,
  );
  if (opts.firstParty) {
    // No registered client is first-party today, so the auto-approve branch
    // (the one that redirects with a code directly) needs a stand-in.
    vi.spyOn(service, 'resolveClient').mockResolvedValue({
      clientId: 'ticketing-mcp',
      clientName: 'Ticketing MCP',
      redirectUris: ['http://127.0.0.1:19836/callback'],
      grantTypes: ['authorization_code'],
      pkceRequired: true,
      allowedScopes: ['tickets:read'],
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
      isFirstParty: true,
    });
  }
  return { service, authService, refreshTokenService, codeStore, consentStore };
}

const authReq = {
  cookies: { token: 'session.jwt' },
  originalUrl: '/oauth/authorize',
  headers: {},
} as unknown as Request;
const tokenReq = { headers: {}, ip: '203.0.113.9' } as unknown as Request;

const authorizeQuery = (extra: Record<string, unknown> = {}) =>
  ({
    response_type: 'code',
    client_id: 'ticketing-mcp',
    redirect_uri: 'http://127.0.0.1:19836/callback',
    scope: 'tickets:read',
    state: 'st',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...extra,
  }) as never;

const errorOf = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as HttpException).getResponse();

describe('resource is an accepted parameter', () => {
  it('lets AuthorizeQuery and TokenBody carry resource (the global ValidationPipe forbids unknown fields, which rejected every MCP client)', async () => {
    const q = plainToInstance(AuthorizeQuery, {
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'http://127.0.0.1:1/cb',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: MCP,
    });
    const t = plainToInstance(TokenBody, {
      grant_type: 'authorization_code',
      client_id: 'c',
      resource: MCP,
    });
    expect(
      await validate(q, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);
    expect(
      await validate(t, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);
  });
});

describe('unknown resource', () => {
  it('authorize answers 400 invalid_target for a resource outside OAUTH_RESOURCES', async () => {
    const { service, codeStore } = makeService();
    const body = await errorOf(
      service.authorize(
        authorizeQuery({ resource: 'http://evil.example/mcp' }),
        authReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
    expect(codeStore.storeCode).not.toHaveBeenCalled();
  });

  it('token answers invalid_target and leaves the code unconsumed', async () => {
    const { service, codeStore } = makeService();
    const body = await errorOf(
      service.token(
        {
          grant_type: 'authorization_code',
          client_id: 'ticketing-mcp',
          code: 'c',
          code_verifier: 'v',
          redirect_uri: 'http://127.0.0.1:19836/callback',
          resource: 'http://evil.example/mcp',
        } as never,
        tokenReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
    expect(codeStore.consumeCode).not.toHaveBeenCalled();
  });
});

describe('resource binds code and token audience', () => {
  const codeRecord = (resource?: string) => ({
    code: 'c',
    clientId: 'ticketing-mcp',
    userId: 'user-1',
    scope: 'tickets:read',
    codeChallenge: 'chal',
    codeChallengeMethod: 'S256',
    redirectUri: 'http://127.0.0.1:19836/callback',
    createdAt: 'now',
    ...(resource ? { resource } : {}),
  });
  vi.mock('./pkce.util', () => ({ verifyPkceChallenge: () => true }));
  const tokenBody = (extra: Record<string, unknown> = {}) =>
    ({
      grant_type: 'authorization_code',
      client_id: 'ticketing-mcp',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:19836/callback',
      ...extra,
    }) as never;

  it('authorize stores the resource on the code record', async () => {
    const { service, codeStore } = makeService({}, { firstParty: true });
    await service.authorize(authorizeQuery({ resource: MCP }), authReq);
    expect(codeStore.storeCode).toHaveBeenCalledWith(
      expect.objectContaining({ resource: MCP }),
    );
  });

  it('token rejects a resource that differs from the authorize one (RFC 8707 §2)', async () => {
    const { service, codeStore, authService } = makeService();
    codeStore.consumeCode.mockResolvedValue(codeRecord(MCP));
    const body = await errorOf(
      service.token(tokenBody({ resource: API }), tokenReq),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
    expect(authService.issueAccessTokenForOAuth).not.toHaveBeenCalled();
  });

  it('token rejects a resource when authorize sent none (it would default to the API audience)', async () => {
    const { service, codeStore } = makeService();
    codeStore.consumeCode.mockResolvedValue(codeRecord());
    const body = await errorOf(
      service.token(tokenBody({ resource: MCP }), tokenReq),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
  });

  it('aud is the authorized resource; iss is OAUTH_ISSUER only when the flag is on', async () => {
    const { service, codeStore, authService } = makeService({
      OAUTH_ISSUER_ENABLED: true,
    });
    codeStore.consumeCode.mockResolvedValue(codeRecord(MCP));
    await service.token(tokenBody({ resource: MCP }), tokenReq);
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      { aud: MCP, iss: 'http://localhost:8000' },
    );
  });

  it('with no resource at all the audience is OAUTH_API_AUDIENCE, so the trial client keeps working', async () => {
    const { service, codeStore, authService } = makeService();
    codeStore.consumeCode.mockResolvedValue(codeRecord());
    await service.token(tokenBody(), tokenReq);
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      expect.objectContaining({ aud: API }),
    );
  });

  it('with the flag off the OAuth token keeps iss auth-service so Kong and REST still accept it', async () => {
    const { service, codeStore, authService } = makeService({
      OAUTH_ISSUER_ENABLED: false,
    });
    codeStore.consumeCode.mockResolvedValue(codeRecord(MCP));
    await service.token(tokenBody(), tokenReq);
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      { aud: MCP, iss: 'auth-service' },
    );
  });

  it('remembers the audience for refresh: the session record carries the resource, and refresh mints the same aud', async () => {
    const { service, codeStore, authService } = makeService();
    codeStore.consumeCode.mockResolvedValue(codeRecord(MCP));
    await service.token(tokenBody(), tokenReq);
    expect(codeStore.storeSessionScope).toHaveBeenCalledWith(
      'sid',
      { scope: 'tickets:read', clientId: 'ticketing-mcp', resource: MCP },
      expect.any(Number),
    );

    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: 'ticketing-mcp',
      resource: MCP,
    });
    authService.issueAccessTokenForOAuth.mockClear();
    await service.token(
      {
        grant_type: 'refresh_token',
        client_id: 'ticketing-mcp',
        refresh_token: 'sid.secret',
      } as never,
      tokenReq,
    );
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      expect.objectContaining({ aud: MCP }),
    );
  });

  it('refresh of a pre-deploy session (no resource on the record) gets the API audience', async () => {
    const { service, codeStore, authService } = makeService();
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: 'ticketing-mcp',
    });
    await service.token(
      {
        grant_type: 'refresh_token',
        client_id: 'ticketing-mcp',
        refresh_token: 'sid.secret',
      } as never,
      tokenReq,
    );
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      expect.objectContaining({ aud: API }),
    );
  });

  it('refresh rejects a resource different from the session audience', async () => {
    const { service, codeStore } = makeService();
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: 'ticketing-mcp',
      resource: MCP,
    });
    const body = await errorOf(
      service.token(
        {
          grant_type: 'refresh_token',
          client_id: 'ticketing-mcp',
          refresh_token: 'sid.secret',
          resource: API,
        } as never,
        tokenReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
  });

  it('a rejected refresh resource mismatch does not rotate: the same refresh token still works afterwards', async () => {
    const { service, codeStore, refreshTokenService, authService } =
      makeService();
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: 'ticketing-mcp',
      resource: MCP,
    });
    const refresh = (resource?: string) =>
      service.token(
        {
          grant_type: 'refresh_token',
          client_id: 'ticketing-mcp',
          refresh_token: 'sid.secret',
          ...(resource ? { resource } : {}),
        } as never,
        tokenReq,
      );

    expect(await errorOf(refresh(API))).toMatchObject({
      error: 'invalid_target',
    });
    expect(refreshTokenService.rotate).not.toHaveBeenCalled();

    const ok = await refresh(MCP);
    expect(ok).toMatchObject({ refresh_token: 'sid2.secret' });
    expect(refreshTokenService.rotate).toHaveBeenCalledTimes(1);
    expect(authService.issueAccessTokenForOAuth).toHaveBeenCalledWith(
      'user-1',
      'tickets:read',
      'ticketing-mcp',
      expect.objectContaining({ aud: MCP }),
    );
  });

  it('refresh applies the token-endpoint rule: no resource bound means an explicit default audience is rejected, without burning the token', async () => {
    const { service, codeStore, refreshTokenService } = makeService();
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: 'ticketing-mcp',
    });
    const body = await errorOf(
      service.token(
        {
          grant_type: 'refresh_token',
          client_id: 'ticketing-mcp',
          refresh_token: 'sid.secret',
          resource: API,
        } as never,
        tokenReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
    expect(refreshTokenService.rotate).not.toHaveBeenCalled();
  });

  it('the consent path keeps the resource: pending consent stores it and approval puts it on the code', async () => {
    const { service, consentStore, codeStore } = makeService();
    await service.authorize(
      authorizeQuery({
        client_id: 'dyn-1',
        redirect_uri: 'http://127.0.0.1:5000/cb',
        resource: MCP,
      }),
      authReq,
    );
    expect(consentStore.storePendingConsent).toHaveBeenCalledWith(
      expect.objectContaining({ resource: MCP }),
    );

    consentStore.consumeConsent.mockResolvedValue({
      requestId: 'req-1',
      clientId: 'dyn-1',
      clientName: 'Dyn',
      userId: 'user-1',
      scope: 'tickets:read',
      redirectUri: 'http://127.0.0.1:5000/cb',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      resource: MCP,
    });
    await service.submitConsent('req-1', 'user-1', true);
    expect(codeStore.storeCode).toHaveBeenCalledWith(
      expect.objectContaining({ resource: MCP }),
    );
  });
});

describe('RFC 9207 iss on every authorize redirect', () => {
  it('the code redirect carries iss (mix-up defence) alongside code and state', async () => {
    const { service } = makeService({}, { firstParty: true });
    const { redirectUrl } = await service.authorize(authorizeQuery(), authReq);
    const u = new URL(redirectUrl);
    expect(u.searchParams.get('iss')).toBe('http://localhost:8000');
    expect(u.searchParams.get('code')).toBe('the-code');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('the consent approval redirect carries iss', async () => {
    const { service, consentStore } = makeService();
    consentStore.consumeConsent.mockResolvedValue({
      requestId: 'r',
      clientId: 'dyn-1',
      userId: 'user-1',
      scope: 'tickets:read',
      redirectUri: 'http://127.0.0.1:5000/cb',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: 's',
    });
    const { redirectUrl } = await service.submitConsent('r', 'user-1', true);
    expect(new URL(redirectUrl).searchParams.get('iss')).toBe(
      'http://localhost:8000',
    );
  });

  it('the deny (error) redirect carries iss, so a client can tell which AS denied', async () => {
    const { service, consentStore } = makeService();
    consentStore.consumeConsent.mockResolvedValue({
      requestId: 'r',
      clientId: 'dyn-1',
      userId: 'user-1',
      scope: 'tickets:read',
      redirectUri: 'http://127.0.0.1:5000/cb',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: 's',
    });
    const { redirectUrl } = await service.submitConsent('r', 'user-1', false);
    const u = new URL(redirectUrl);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('iss')).toBe('http://localhost:8000');
  });
});

describe('loopback redirect port matching in authorize', () => {
  it('accepts a random loopback port and redirects to the port actually requested', async () => {
    const { service, codeStore } = makeService({}, { firstParty: true });
    const { redirectUrl } = await service.authorize(
      authorizeQuery({ redirect_uri: 'http://127.0.0.1:54321/callback' }),
      authReq,
    );
    expect(redirectUrl.startsWith('http://127.0.0.1:54321/callback?')).toBe(
      true,
    );
    expect(codeStore.storeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'http://127.0.0.1:54321/callback',
      }),
    );
  });

  it('rejects a non-loopback redirect that only changes the port', async () => {
    const { service } = makeService();
    const body = await errorOf(
      service.authorize(
        authorizeQuery({
          client_id: 'dyn-1',
          redirect_uri: 'https://127.0.0.1:5000/cb',
        }),
        authReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_request' });
  });
});
