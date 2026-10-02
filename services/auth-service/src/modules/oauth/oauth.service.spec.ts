import { describe, it, expect, vi } from 'vitest';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { OAuthService } from './oauth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';

function makeService() {
  const authService = {
    // An OAuth access token verifies as a JWT, so a session check that only
    // calls verifyAccessToken would accept it (F11b). Task 2 relies on this.
    verifyAccessToken: vi.fn().mockResolvedValue({
      sub: 'user-1',
      email: 'user@example.com',
      jti: 'jti-1',
      scope: 'tickets:read',
      client_id: 'ticketing-mcp',
    }),
    verifySessionAccessToken: vi
      .fn()
      .mockRejectedValue(new UnauthorizedException()),
  };
  const refreshTokenService = {
    issue: vi.fn(),
    rotate: vi.fn().mockRejectedValue(new UnauthorizedException()),
    extractSessionId: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
  };
  const usersRepo = { findById: vi.fn() };
  const codeStore = {
    getSessionScope: vi.fn(),
    storeSessionScope: vi.fn(),
    storeCode: vi.fn(),
  };
  const config = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  };
  const dynamicClientService = { findClient: vi.fn().mockResolvedValue(null) };
  const consentStore = {
    storePendingConsent: vi.fn().mockResolvedValue('request-1'),
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
  );
  return {
    service,
    authService,
    refreshTokenService,
    codeStore,
    consentStore,
    dynamicClientService,
  };
}

describe('OAuthService refresh_token grant', () => {
  it('only lets RefreshTokenService rotate this client’s session, and answers invalid_grant (F1b)', async () => {
    const { service, refreshTokenService, codeStore } = makeService();
    const req = { headers: {}, ip: '203.0.113.9' } as unknown as Request;

    const err = await service
      .token(
        {
          grant_type: 'refresh_token',
          refresh_token: 'sid.secret',
          client_id: 'ticketing-mcp',
        } as never,
        req,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({
      error: 'invalid_grant',
    });
    expect(refreshTokenService.rotate).toHaveBeenCalledWith(
      'sid.secret',
      expect.any(Object),
      { kind: 'oauth', clientId: 'ticketing-mcp' },
    );
    expect(codeStore.getSessionScope).not.toHaveBeenCalled();
  });
});

describe('OAuthService authorize session check (F11b)', () => {
  it('sends a request whose cookie holds an OAuth access token to sign-in instead of consent', async () => {
    const { service, authService, consentStore } = makeService();
    const req = {
      cookies: { token: 'oauth.access.token' },
      originalUrl: '/oauth/authorize?client_id=ticketing-mcp',
      headers: {},
    } as unknown as Request;

    const { redirectUrl } = await service.authorize(
      {
        response_type: 'code',
        client_id: 'ticketing-mcp',
        redirect_uri: 'http://127.0.0.1:19836/callback',
        scope: 'orders:create payments:create',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      } as never,
      req,
    );

    expect(authService.verifySessionAccessToken).toHaveBeenCalledWith(
      'oauth.access.token',
    );
    expect(
      redirectUrl.startsWith('http://localhost:4000/auth/signin?next='),
    ).toBe(true);
    expect(consentStore.storePendingConsent).not.toHaveBeenCalled();
  });
});

describe('OAuthService listClients (L-2, auth half)', () => {
  it('L-2 (auth half): a dynamic client is listed by its registered name, not its UUID, so Connected apps can label it', async () => {
    const { service, refreshTokenService, codeStore, dynamicClientService } =
      makeService();
    const uuid = '6f1c2f0e-0000-4000-8000-000000000001';
    refreshTokenService.listSessions.mockResolvedValue([
      { sessionId: 's1', lastRotatedAt: '2026-10-02T00:00:00.000Z' },
    ]);
    codeStore.getSessionScope.mockResolvedValue({
      clientId: uuid,
      scope: 'tickets:read',
    });
    dynamicClientService.findClient.mockResolvedValue({
      clientId: uuid,
      clientName: 'Claude Desktop',
      redirectUris: ['http://127.0.0.1:5000/cb'],
      allowedScopes: ['tickets:read'],
      grantTypes: ['authorization_code'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
      isFirstParty: false,
      registeredAt: '2026-10-01T00:00:00.000Z',
    });

    const rows = await service.listClients('user-1');

    expect(rows).toEqual([
      {
        clientId: uuid,
        clientName: 'Claude Desktop',
        scope: 'tickets:read',
        sessionId: 's1',
        lastRotatedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
  });

  it('falls back to the client id when the dynamic registration has expired, so the row still renders', async () => {
    const { service, refreshTokenService, codeStore } = makeService();
    refreshTokenService.listSessions.mockResolvedValue([
      { sessionId: 's1', lastRotatedAt: '2026-10-02T00:00:00.000Z' },
    ]);
    codeStore.getSessionScope.mockResolvedValue({
      clientId: 'gone-uuid',
      scope: 'tickets:read',
    });
    const rows = await service.listClients('user-1');
    expect(rows[0]?.clientName).toBe('gone-uuid');
  });
});

describe('OAuthService refresh_token grant, foreign client', () => {
  it("a client cannot refresh another client's session: invalid_grant, and the owner's scope marker is untouched", async () => {
    // Real RefreshTokenService over a fake Redis: the ownership rule lives
    // there, so a mocked rotate() would prove nothing about it.
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: vi.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      del: vi.fn(),
      sadd: vi.fn().mockResolvedValue(1),
      srem: vi.fn(),
      smembers: vi.fn(),
    };
    const refresh = new RefreshTokenService(
      redis as never,
      {
        get: (_k: string, fb?: unknown) => fb ?? 604800,
      } as never,
    );
    const victimToken = await refresh.issue('user-1', {}, 'ticketing-mcp');

    const { service, codeStore, dynamicClientService } = makeService();
    (
      service as unknown as { refreshTokenService: unknown }
    ).refreshTokenService = refresh;
    dynamicClientService.findClient.mockResolvedValue({
      clientId: 'attacker-uuid',
      clientName: 'Attacker',
      redirectUris: ['http://127.0.0.1:5000/cb'],
      allowedScopes: ['tickets:read'],
      grantTypes: ['authorization_code'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
      isFirstParty: false,
      registeredAt: '2026-10-01T00:00:00.000Z',
    });
    redis.set.mockClear();

    const err = await service
      .token(
        {
          grant_type: 'refresh_token',
          refresh_token: victimToken,
          client_id: 'attacker-uuid',
        } as never,
        { headers: {}, ip: '203.0.113.9' } as unknown as Request,
      )
      .catch((e: unknown) => e);

    expect((err as HttpException).getResponse()).toMatchObject({
      error: 'invalid_grant',
    });
    expect(redis.set).not.toHaveBeenCalled();
    expect(codeStore.storeSessionScope).not.toHaveBeenCalled();
  });
});
