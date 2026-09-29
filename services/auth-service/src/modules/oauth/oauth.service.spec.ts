import { describe, it, expect, vi } from 'vitest';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { OAuthService } from './oauth.service';

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
  );
  return { service, authService, refreshTokenService, codeStore, consentStore };
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
