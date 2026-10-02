/* eslint-disable @typescript-eslint/require-await -- async fakes stand in for Redis / network seams */
import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { CimdClientService } from './cimd-client.service';
import type { CimdFetchResult } from './cimd-fetcher';

const URL_ID = 'https://app.example.com/oauth/client.json';
const CHALLENGE = 'x'.repeat(43);
const CALLBACK = 'https://app.example.com/callback';

const docBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_id: URL_ID,
    client_name: 'Example Agent',
    redirect_uris: [CALLBACK],
    ...over,
  });

function makeService(opts: { cimd?: boolean } = {}) {
  const env: Record<string, unknown> = {
    OAUTH_CIMD_ENABLED: opts.cimd ?? true,
  };
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => env[key] ?? fallback),
  };
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  };
  const fetchDoc = vi.fn<(u: string) => Promise<CimdFetchResult>>(async () => ({
    body: docBody(),
  }));
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const cimd = new CimdClientService(
    redis as never,
    config as never,
    logger as never,
    fetchDoc,
  );
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
    listSessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  };
  const usersRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', email: 'u@x.test' }),
  };
  const codeStore = {
    storeCode: vi.fn().mockResolvedValue('the-code'),
    consumeCode: vi.fn(),
    storeSessionScope: vi.fn(),
    getSessionScope: vi.fn(),
    deleteSessionScope: vi.fn().mockResolvedValue(undefined),
  };
  const dynamicClientService = {
    findClient: vi.fn().mockResolvedValue(null),
  };
  const consentRecords = new Map<string, Record<string, unknown>>();
  const consentStore = {
    storePendingConsent: vi.fn(async (data: Record<string, unknown>) => {
      consentRecords.set('req-1', { ...data, requestId: 'req-1' });
      return 'req-1';
    }),
    getConsent: vi.fn(async (id: string) => consentRecords.get(id) ?? null),
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
    cimd,
  );
  return {
    service,
    cimd,
    fetchDoc,
    store,
    refreshTokenService,
    codeStore,
    consentStore,
    dynamicClientService,
  };
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
    client_id: URL_ID,
    redirect_uri: CALLBACK,
    scope: 'tickets:read',
    state: 'st',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...extra,
  }) as never;

const errorOf = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as HttpException).getResponse();

describe('CIMD at /oauth/authorize', () => {
  it('I-5: a valid document authorizes: the user is sent to consent, which records the verified host of the client_id URL', async () => {
    const { service, consentStore } = makeService();
    const { redirectUrl } = await service.authorize(authorizeQuery(), authReq);

    expect(redirectUrl).toContain('/oauth/consent?request_id=req-1');
    expect(consentStore.storePendingConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: URL_ID,
        clientName: 'Example Agent',
        clientDomain: 'app.example.com',
        domainSource: 'client_id',
        isFirstParty: false,
        redirectUri: CALLBACK,
      }),
    );
  });

  it('I-5: the consent summary the UI reads carries the domain, its source and the first-party marker', async () => {
    const { service, consentStore } = makeService();
    await service.authorize(authorizeQuery(), authReq);
    consentStore.getConsent.mockClear();
    const summary = await service.getConsentRequest('req-1', 'user-1');
    expect(summary).toMatchObject({
      clientDomain: 'app.example.com',
      domainSource: 'client_id',
      isFirstParty: false,
    });
  });

  it('I-5: a DCR client is labelled with the host of the redirect URI the code is sent to, not a name it chose', async () => {
    const { service, consentStore, dynamicClientService } = makeService();
    dynamicClientService.findClient.mockResolvedValue({
      clientId: 'dyn-1',
      clientName: 'Friendly Name',
      redirectUris: ['https://cb.evil.example/cb'],
      grantTypes: ['authorization_code'],
      allowedScopes: ['tickets:read'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
    });
    await service.authorize(
      authorizeQuery({
        client_id: 'dyn-1',
        redirect_uri: 'https://cb.evil.example/cb',
      }),
      authReq,
    );
    expect(consentStore.storePendingConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientDomain: 'cb.evil.example',
        domainSource: 'redirect_uri',
        isFirstParty: false,
      }),
    );
  });

  it('I-6: an http URL and a root-path URL are refused as unknown clients without any fetch', async () => {
    for (const bad of [
      'http://app.example.com/oauth/client.json',
      'https://app.example.com/',
      'https://app.example.com',
    ]) {
      const { service, fetchDoc, dynamicClientService } = makeService();
      const body = await errorOf(
        service.authorize(authorizeQuery({ client_id: bad }), authReq),
      );
      expect(body).toMatchObject({ error: 'invalid_client' });
      expect(fetchDoc).not.toHaveBeenCalled();
      // A URL never reaches the opaque-id store.
      expect(dynamicClientService.findClient).not.toHaveBeenCalled();
    }
  });

  it('I-8: with the flag off a URL client_id gets the normal unknown-client error and nothing is fetched', async () => {
    const { service, fetchDoc } = makeService({ cimd: false });
    const body = await errorOf(service.authorize(authorizeQuery(), authReq));
    expect(body).toEqual({
      error: 'invalid_client',
      error_description: 'Unknown client_id',
    });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('I-4: a document that names a different client_id is refused, and the caller is not told why (no SSRF oracle)', async () => {
    const { service, fetchDoc } = makeService();
    fetchDoc.mockResolvedValue({
      body: docBody({ client_id: 'https://evil.example.com/x.json' }),
    });
    const body = (await errorOf(
      service.authorize(authorizeQuery(), authReq),
    )) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client');
    expect(body.error_description).not.toMatch(
      /mismatch|blocked|dns|timeout|redirect/i,
    );
  });

  it('a redirect_uri the document does not list is refused', async () => {
    const { service } = makeService();
    const body = await errorOf(
      service.authorize(
        authorizeQuery({ redirect_uri: 'https://evil.example.com/cb' }),
        authReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects an unknown resource BEFORE fetching: a request that would fail anyway must not cost an outbound connection', async () => {
    const { service, fetchDoc } = makeService();
    const body = await errorOf(
      service.authorize(
        authorizeQuery({ resource: 'https://evil.example/mcp' }),
        authReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_target' });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('I-10: two authorizations for one client fetch once', async () => {
    const { service, fetchDoc } = makeService();
    await service.authorize(authorizeQuery(), authReq);
    await service.authorize(authorizeQuery(), authReq);
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });
});

describe('CIMD at /oauth/token', () => {
  it('re-resolves the client from the cache (or a guarded refetch), never from anything the caller sent, and fails closed when the document is gone', async () => {
    const { service, fetchDoc, codeStore } = makeService();
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: URL_ID,
    });
    const refresh = () =>
      service.token(
        {
          grant_type: 'refresh_token',
          refresh_token: 'sid.secret',
          client_id: URL_ID,
        } as never,
        tokenReq,
      );
    await expect(refresh()).resolves.toMatchObject({ token_type: 'Bearer' });
    await refresh();
    expect(fetchDoc).toHaveBeenCalledTimes(1);

    const gone = makeService();
    gone.fetchDoc.mockRejectedValue(new Error('down'));
    const body = await errorOf(
      gone.service.token(
        {
          grant_type: 'refresh_token',
          refresh_token: 'sid.secret',
          client_id: URL_ID,
        } as never,
        tokenReq,
      ),
    );
    expect(body).toMatchObject({ error: 'invalid_client' });
  });
});

describe('I-7: listing and revoking a CIMD grant', () => {
  const session = {
    sessionId: 'sid-1',
    lastRotatedAt: '2026-10-02T10:00:00.000Z',
  };

  it('I-7: the listing shows the URL id, the cached name and the verified host, without fetching', async () => {
    const { service, cimd, fetchDoc, refreshTokenService, codeStore } =
      makeService();
    await cimd.resolve(URL_ID); // warm the cache like a prior authorize would
    fetchDoc.mockClear();
    refreshTokenService.listSessions.mockResolvedValue([session]);
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: URL_ID,
    });

    const [item] = await service.listClients('user-1');

    expect(item).toMatchObject({
      clientId: URL_ID,
      clientName: 'Example Agent',
      clientDomain: 'app.example.com',
      domainSource: 'client_id',
      isFirstParty: false,
    });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('I-7: a CIMD grant is still listed (named by its host) when its document has left the cache or the flag is off', async () => {
    const { service, fetchDoc, refreshTokenService, codeStore } = makeService({
      cimd: false,
    });
    refreshTokenService.listSessions.mockResolvedValue([session]);
    codeStore.getSessionScope.mockResolvedValue({
      scope: 'tickets:read',
      clientId: URL_ID,
    });
    const [item] = await service.listClients('user-1');
    expect(item).toMatchObject({
      clientId: URL_ID,
      clientName: 'app.example.com',
      clientDomain: 'app.example.com',
    });
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('I-7: a static client is listed as first-party with its redirect host, a DCR client as third-party', async () => {
    const { service, refreshTokenService, codeStore, dynamicClientService } =
      makeService();
    refreshTokenService.listSessions.mockResolvedValue([
      session,
      { ...session, sessionId: 'sid-2' },
    ]);
    codeStore.getSessionScope.mockImplementation(async (sid: string) => ({
      scope: 'tickets:read',
      clientId: sid === 'sid-1' ? 'ticketing-mcp' : 'dyn-1',
    }));
    dynamicClientService.findClient.mockResolvedValue({
      clientId: 'dyn-1',
      clientName: 'Dyn',
      redirectUris: ['https://cb.example.org/cb'],
      grantTypes: ['authorization_code'],
      allowedScopes: ['tickets:read'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 3600,
    });
    const items = await service.listClients('user-1');
    const byId = Object.fromEntries(items.map((i) => [i.clientId, i]));
    expect(byId['ticketing-mcp']).toMatchObject({
      isFirstParty: true,
      domainSource: 'redirect_uri',
      clientDomain: '127.0.0.1:19836',
    });
    expect(byId['dyn-1']).toMatchObject({
      isFirstParty: false,
      domainSource: 'redirect_uri',
      clientDomain: 'cb.example.org',
    });
  });

  it('I-7: revokeClient removes the sessions of a URL client id and leaves other clients alone', async () => {
    const { service, refreshTokenService, codeStore } = makeService();
    refreshTokenService.listSessions.mockResolvedValue([
      session,
      { ...session, sessionId: 'sid-2' },
    ]);
    codeStore.getSessionScope.mockImplementation(async (sid: string) => ({
      scope: 'tickets:read',
      clientId: sid === 'sid-1' ? URL_ID : 'other',
    }));
    await service.revokeClient('user-1', URL_ID);
    expect(refreshTokenService.revokeSession).toHaveBeenCalledTimes(1);
    expect(refreshTokenService.revokeSession).toHaveBeenCalledWith(
      'user-1',
      'sid-1',
    );
  });
});

describe('I-7: DELETE through the controller', () => {
  function makeController() {
    const oauthService = { revokeClient: vi.fn().mockResolvedValue(undefined) };
    const validator = { isValidSignature: vi.fn().mockReturnValue(true) };
    const controller = new OAuthController(
      oauthService as never,
      validator as never,
    );
    const req = {
      headers: { 'x-user-id': 'user-1', 'x-user-id-sig': 'sig' },
    } as unknown as Request;
    return { controller, oauthService, req };
  }

  it('I-7: DELETE /oauth/clients?client_id=<url> revokes a URL id (no encoded slash in a path segment to survive proxies)', async () => {
    const { controller, oauthService, req } = makeController();
    await controller.revokeClientByQuery(URL_ID, req);
    expect(oauthService.revokeClient).toHaveBeenCalledWith('user-1', URL_ID);
  });

  it('I-7: the original DELETE /oauth/clients/:clientId path form still works for opaque ids', async () => {
    const { controller, oauthService, req } = makeController();
    await controller.revokeClient('ticketing-mcp', req);
    expect(oauthService.revokeClient).toHaveBeenCalledWith(
      'user-1',
      'ticketing-mcp',
    );
  });

  it('I-7: a missing, empty, repeated or oversized client_id is a 400, never a revoke-everything', async () => {
    const { controller, oauthService, req } = makeController();
    for (const bad of [undefined, '', ['a', 'b'], 'x'.repeat(3000)]) {
      await expect(
        controller.revokeClientByQuery(bad as never, req),
      ).rejects.toBeInstanceOf(HttpException);
    }
    expect(oauthService.revokeClient).not.toHaveBeenCalled();
  });

  it('I-7: the signed X-User-Id is still required on the query form', async () => {
    const { controller, oauthService } = makeController();
    await expect(
      controller.revokeClientByQuery(URL_ID, {
        headers: {},
      } as unknown as Request),
    ).rejects.toBeInstanceOf(HttpException);
    expect(oauthService.revokeClient).not.toHaveBeenCalled();
  });
});
