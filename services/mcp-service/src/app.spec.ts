import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import {
  mintToken,
  mintUnsecuredToken,
  permissiveHmacJwks,
  stubJwks,
  testConfig,
} from './testkit.ts';

const app = createApp({ config: testConfig, jwks: stubJwks });

const initialize = (
  token?: string,
  target: typeof app = app,
): Promise<Response> =>
  target(
    new Request(testConfig.MCP_RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    }),
  );

describe('bearer challenge (C-6)', () => {
  it('G-1: no token gets 401 with resource_metadata and the initial read scopes, so a client can discover the AS and ask for the right scopes', async () => {
    const res = await initialize();
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate') ?? '';
    expect(header).toMatch(/^Bearer error="invalid_token"/);
    expect(header).toContain(
      'resource_metadata="http://localhost:8000/.well-known/oauth-protected-resource/mcp"',
    );
    expect(header).toContain(
      'scope="tickets:read seating:read orders:read payments:read"',
    );
  });
});

describe('token verification', () => {
  it('G-2: a token minted for another audience is rejected (token passthrough / confused deputy)', async () => {
    const res = await initialize(
      await mintToken({ aud: 'http://localhost:8000/api' }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_token',
    );
  });

  it('G-3: a wrong issuer is rejected, so the browser token issuer cannot be replayed', async () => {
    const res = await initialize(await mintToken({ iss: 'auth-service' }));
    expect(res.status).toBe(401);
  });

  it('G-3: a token signed by a different key with the published kid is rejected, so signatures are really verified', async () => {
    const res = await initialize(await mintToken({ wrongKey: true }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('G-3: an alg none token is rejected', async () => {
    const res = await initialize(mintUnsecuredToken());
    expect(res.status).toBe(401);
  });

  it('G-3: an HS256 token is rejected even when the key resolver would supply an HMAC key (pins the RS256 allowlist)', async () => {
    const permissive = createApp({
      config: testConfig,
      jwks: permissiveHmacJwks,
    });
    const res = await initialize(await mintToken({ hs256: true }), permissive);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const res = await initialize(await mintToken({ expiresIn: '-1m' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token with no client_id (C-1 invariant: every OAuth token carries it)', async () => {
    const res = await initialize(await mintToken({ clientId: null }));
    expect(res.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const res = await initialize(await mintToken());
    expect(res.status).toBe(200);
  });
});

describe('JWKS outage', () => {
  let jwksServer: Server | undefined;
  afterEach(() => {
    jwksServer?.close();
    jwksServer = undefined;
  });

  async function appWithJwks(
    status: number,
    body: string,
  ): Promise<typeof app> {
    jwksServer = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((r) => jwksServer!.listen(0, '127.0.0.1', r));
    const { port } = jwksServer.address() as AddressInfo;
    return createApp({
      config: testConfig,
      jwks: createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks`)),
    });
  }

  it('a JWKS 500 gives a 5xx, not a 401 that would send clients into re-authorization', async () => {
    const res = await initialize(
      await mintToken(),
      await appWithJwks(500, '{}'),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('a malformed JWKS gives a 5xx, not a 401', async () => {
    const res = await initialize(
      await mintToken(),
      await appWithJwks(200, '{"keys":"nope"}'),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('protected resource metadata (C-3)', () => {
  it('G-4: the PRM body equals contract C-3 exactly', async () => {
    const res = await app(
      new Request(
        'http://localhost:8000/.well-known/oauth-protected-resource/mcp',
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      resource: 'http://localhost:8000/mcp',
      authorization_servers: ['http://localhost:8000'],
      scopes_supported: [
        'tickets:read',
        'seating:read',
        'orders:read',
        'orders:create',
        'orders:cancel',
        'payments:read',
        'payments:create',
      ],
      bearer_methods_supported: ['header'],
      resource_name: 'Ticketing',
    });
  });

  it('does not re-serve the authorization server document (auth-service owns it)', async () => {
    const res = await app(
      new Request(
        'http://localhost:8000/.well-known/oauth-authorization-server',
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('health', () => {
  it('/health answers without a token so probes work', async () => {
    const res = await app(new Request('http://localhost:3000/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ status: 'ok' });
  });
});
