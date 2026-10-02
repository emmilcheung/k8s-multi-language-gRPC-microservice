import { describe, expect, it } from 'vitest';
import { ExchangeError, createTokenExchange } from './exchange.ts';

const URL_ = 'http://auth-service:3000/oauth/token';

function setup(expiresIn = 300) {
  let now = 1_000_000_000_000;
  const calls: { headers: Headers; body: URLSearchParams }[] = [];
  const fetchStub = (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: new Headers(init?.headers),
      body: new URLSearchParams(String(init?.body)),
    });
    return Promise.resolve(
      Response.json({
        access_token: `api-token-${calls.length}`,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: 'orders:create',
      }),
    );
  };
  const exchange = createTokenExchange({
    url: URL_,
    clientId: 'mcp-service',
    clientSecret: 'throwaway-secret',
    resource: 'http://localhost:8000/api',
    fetch: fetchStub,
    now: () => now,
    maxEntries: 2,
  });
  return {
    exchange,
    calls,
    advance: (seconds: number) => (now += seconds * 1000),
    nowSeconds: () => Math.floor(now / 1000),
  };
}

describe('token exchange client (C-5)', () => {
  it('J-5: sends the C-5 request shape (Basic client auth, token-exchange grant, API resource, narrow scope)', async () => {
    const { exchange, calls, nowSeconds } = setup();
    await exchange('mcp-jwt', nowSeconds() + 900, 'orders:create');
    const { headers, body } = calls[0]!;
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('mcp-service:throwaway-secret').toString('base64')}`,
    );
    expect(headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'mcp-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: 'http://localhost:8000/api',
      scope: 'orders:create',
    });
  });

  it('J-5: caches per sha256(token)+scope, so a token or scope change never reuses another grant', async () => {
    const { exchange, calls, nowSeconds } = setup();
    const exp = nowSeconds() + 900;
    const a = await exchange('tok-a', exp, 'orders:read');
    expect(await exchange('tok-a', exp, 'orders:read')).toBe(a);
    expect(calls).toHaveLength(1);
    await exchange('tok-a', exp, 'orders:create'); // other scope
    await exchange('tok-b', exp, 'orders:read'); // other subject
    expect(calls).toHaveLength(3);
  });

  it('J-5: refreshes 30 s before the exchanged token expires', async () => {
    const { exchange, calls, advance, nowSeconds } = setup(300);
    const exp = nowSeconds() + 3600;
    await exchange('tok', exp, 'orders:read');
    advance(269); // 31 s of life left: still served from cache
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(1);
    advance(2); // 29 s left: inside the safety window, must refresh
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(2);
  });

  it('J-5: never caches past the subject token expiry minus 30 s', async () => {
    const { exchange, calls, advance, nowSeconds } = setup(300);
    const exp = nowSeconds() + 100; // subject dies before the 300 s API token
    await exchange('tok', exp, 'orders:read');
    advance(69);
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(1);
    advance(2);
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(2);
  });

  it('J-5: the cache is bounded (LRU), so many distinct tokens cannot grow memory without limit', async () => {
    const { exchange, calls, nowSeconds } = setup();
    const exp = nowSeconds() + 900;
    await exchange('t1', exp, 's');
    await exchange('t2', exp, 's');
    await exchange('t1', exp, 's'); // t1 is now most recent
    await exchange('t3', exp, 's'); // evicts t2
    expect(calls).toHaveLength(3);
    await exchange('t1', exp, 's');
    expect(calls).toHaveLength(3);
    await exchange('t2', exp, 's');
    expect(calls).toHaveLength(4);
  });

  it('J-5: a failed exchange is not cached and its response body never reaches the error', async () => {
    let n = 0;
    const exchange = createTokenExchange({
      url: URL_,
      clientId: 'mcp-service',
      clientSecret: 'throwaway-secret',
      resource: 'http://localhost:8000/api',
      fetch: () =>
        Promise.resolve(
          ++n === 1
            ? Response.json(
                { error: 'invalid_grant', error_description: 'LEAK-ME' },
                { status: 400 },
              )
            : Response.json({
                access_token: 'ok',
                token_type: 'Bearer',
                expires_in: 300,
              }),
        ),
    });
    const err = await exchange('tok', undefined, 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExchangeError);
    expect(String((err as Error).message)).not.toContain('LEAK-ME');
    expect(await exchange('tok', undefined, 's')).toBe('ok');
  });
});
