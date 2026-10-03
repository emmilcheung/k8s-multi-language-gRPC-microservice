import { describe, expect, it } from 'vitest';
import { ExchangeError, createTokenExchange } from './exchange.ts';

const URL_ = 'http://auth-service:3000/oauth/token';

function setup(expiresIn = 300) {
  let now = 1_000_000_000_000;
  const calls: { headers: Headers; body: URLSearchParams }[] = [];
  const fetchStub = (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: new Headers(init?.headers),
      body: new URLSearchParams((init?.body as URLSearchParams).toString()),
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
  it('R10: client id and secret are form-urlencoded before Basic encoding, so auth-service (RFC 6749 2.3.1) recovers them', async () => {
    const secret = 'a+b/c=d%e:f g';
    const calls: Headers[] = [];
    const exchange = createTokenExchange({
      url: URL_,
      clientId: 'mcp service',
      clientSecret: secret,
      resource: 'http://localhost:8000/api',
      fetch: (_url, init) => {
        calls.push(new Headers(init?.headers));
        return Promise.resolve(
          Response.json({ access_token: 't', expires_in: 300 }),
        );
      },
    });
    await exchange('mcp-jwt', undefined, 'orders:read');
    // Decode the way auth-service does: base64, split on the FIRST colon,
    // `+` to space, then percent-decode.
    const raw = Buffer.from(
      (calls[0].get('authorization') ?? '').replace(/^Basic /, ''),
      'base64',
    ).toString();
    const i = raw.indexOf(':');
    const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
    expect(decode(raw.slice(0, i))).toBe('mcp service');
    expect(decode(raw.slice(i + 1))).toBe(secret);
  });

  it('J-5: sends the C-5 request shape (Basic client auth, token-exchange grant, API resource, narrow scope)', async () => {
    const { exchange, calls, nowSeconds } = setup();
    await exchange('mcp-jwt', nowSeconds() + 900, 'orders:create');
    const { headers, body } = calls[0];
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
    const { exchange, calls, advance, nowSeconds } = setup(50);
    const exp = nowSeconds() + 3600;
    await exchange('tok', exp, 'orders:read');
    advance(19); // 31 s of life left: still served from cache
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(1);
    advance(2); // 29 s left: inside the safety window, must refresh
    await exchange('tok', exp, 'orders:read');
    expect(calls).toHaveLength(2);
  });

  it('asks auth-service again within a minute even when the tokens live longer, so a disconnected app is cut off quickly', async () => {
    const { exchange, calls, advance, nowSeconds } = setup(300);
    const exp = nowSeconds() + 900;
    await exchange('tok', exp, 'orders:create');
    advance(59);
    await exchange('tok', exp, 'orders:create');
    expect(calls).toHaveLength(1);
    advance(2);
    await exchange('tok', exp, 'orders:create');
    expect(calls).toHaveLength(2);
  });

  it('J-5: never caches past the subject token expiry minus 30 s', async () => {
    const { exchange, calls, advance, nowSeconds } = setup(300);
    const exp = nowSeconds() + 80; // subject dies before the 300 s API token
    await exchange('tok', exp, 'orders:read');
    advance(49);
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

  it('R5: a hung exchange endpoint times out into a status-less failure instead of hanging every tool call', async () => {
    const exchange = createTokenExchange({
      url: URL_,
      clientId: 'mcp-service',
      clientSecret: 'throwaway-secret',
      resource: 'http://localhost:8000/api',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          );
        }),
    });
    await expect(exchange('t', undefined, 'orders:read')).rejects.toMatchObject(
      { status: undefined, oauthError: undefined },
    );
  });

  it('R5: only the RFC 6749 error code survives from a rejection body, and only if it looks like a code', async () => {
    const reject = (body: unknown) =>
      createTokenExchange({
        url: URL_,
        clientId: 'c',
        clientSecret: 's',
        resource: 'r',
        fetch: () => Promise.resolve(Response.json(body, { status: 400 })),
      })('t', undefined, 'orders:read');
    await expect(reject({ error: 'invalid_grant' })).rejects.toMatchObject({
      status: 400,
      oauthError: 'invalid_grant',
    });
    await expect(
      reject({ error: 'Secret text with spaces' }),
    ).rejects.toMatchObject({ status: 400, oauthError: undefined });
  });

  it('R12: an exchange whose body stalls after the headers fails as an ExchangeError, not a raw abort', async () => {
    const exchange = createTokenExchange({
      url: URL_,
      clientId: 'c',
      clientSecret: 's',
      resource: 'r',
      timeoutMs: 30,
      fetch: (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('t', 'TimeoutError')),
                );
              },
            }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      exchange('t', undefined, 'orders:read'),
    ).rejects.toBeInstanceOf(ExchangeError);
  });
});
