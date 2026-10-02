import { describe, it, expect, vi } from 'vitest';
import { CimdFetchError } from './cimd-fetcher';
import type { CimdFetchResult } from './cimd-fetcher';
import { CimdClientService, cimdCacheTtlSeconds } from './cimd-client.service';

const URL_ID = 'https://app.example.com/oauth/client.json';
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    client_id: URL_ID,
    client_name: 'Example Agent',
    redirect_uris: ['https://app.example.com/callback'],
    ...over,
  });

function make(opts: { enabled?: boolean } = {}) {
  const store = new Map<string, { value: string; ttl: number }>();
  const redis = {
    get: vi.fn((k: string) => Promise.resolve(store.get(k)?.value ?? null)),
    set: vi.fn((k: string, v: string, _ex: string, ttl: number) => {
      store.set(k, { value: v, ttl });
      return Promise.resolve('OK');
    }),
  };
  const fetchDoc = vi.fn<(url: string) => Promise<CimdFetchResult>>(() =>
    Promise.resolve({ body: body() }),
  );
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const config = {
    get: (k: string) =>
      k === 'OAUTH_CIMD_ENABLED' ? (opts.enabled ?? true) : undefined,
  };
  const service = new CimdClientService(
    redis as never,
    config as never,
    logger as never,
    fetchDoc,
  );
  return { service, redis, store, fetchDoc, logger };
}

describe('cimdCacheTtlSeconds (I-10)', () => {
  it.each([
    [undefined, 300],
    ['', 300],
    ['public, max-age=3600', 3600],
    ['max-age=0', 60],
    ['max-age=5', 60],
    ['no-store', 60],
    ['no-cache', 60],
    ['no-store, max-age=3600', 60],
    ['max-age=999999999', 86400],
    ['max-age=86400', 86400],
    ['max-age=abc', 300],
    ['max-age=-5', 300],
    ['MAX-AGE=600', 600],
  ])('I-10: Cache-Control %j caches for %i s', (header, ttl) => {
    expect(cimdCacheTtlSeconds(header)).toBe(ttl);
  });
});

describe('CimdClientService (I-10)', () => {
  it('I-5: a valid document resolves to a client', async () => {
    const { service } = make();
    const r = await service.resolve(URL_ID);
    expect(r.ok && r.client.clientName).toBe('Example Agent');
  });

  it('I-10: a second resolve within the TTL does not fetch again', async () => {
    const { service, fetchDoc } = make();
    await service.resolve(URL_ID);
    const second = await service.resolve(URL_ID);
    expect(second.ok).toBe(true);
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });

  it('I-10: max-age=0 and no-store still cache for the 60 s floor, so a caller cannot force a fetch per request', async () => {
    for (const cc of ['max-age=0', 'no-store']) {
      const { service, fetchDoc, store } = make();
      fetchDoc.mockResolvedValue({ body: body(), cacheControl: cc });
      await service.resolve(URL_ID);
      await service.resolve(URL_ID);
      expect(fetchDoc).toHaveBeenCalledTimes(1);
      expect([...store.values()][0].ttl).toBe(60);
    }
  });

  it('I-10: the TTL is clamped at 24 h whatever the server asks for', async () => {
    const { service, fetchDoc, store } = make();
    fetchDoc.mockResolvedValue({
      body: body(),
      cacheControl: 'max-age=31536000',
    });
    await service.resolve(URL_ID);
    expect([...store.values()][0].ttl).toBe(86400);
  });

  it('I-10: a failed fetch is negatively cached for 60 s and the reason survives the cache', async () => {
    const { service, fetchDoc, store } = make();
    fetchDoc.mockRejectedValue(new CimdFetchError('timeout'));
    const first = await service.resolve(URL_ID);
    const second = await service.resolve(URL_ID);
    expect(first).toEqual({ ok: false, reason: 'timeout' });
    expect(second).toEqual({ ok: false, reason: 'timeout' });
    expect(fetchDoc).toHaveBeenCalledTimes(1);
    expect([...store.values()][0].ttl).toBe(60);
  });

  it('I-10/I-4: an invalid document (client_id mismatch) is negatively cached too', async () => {
    const { service, fetchDoc } = make();
    fetchDoc.mockResolvedValue({
      body: body({ client_id: 'https://evil.example.com/x.json' }),
    });
    expect(await service.resolve(URL_ID)).toEqual({
      ok: false,
      reason: 'invalid_document',
    });
    await service.resolve(URL_ID);
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });

  it('the cache key is a hash of the URL, never the URL itself, so a client-chosen id cannot shape a Redis key', async () => {
    const { service, store } = make();
    await service.resolve(URL_ID);
    const key = [...store.keys()][0];
    expect(key).toMatch(/^auth-service:oauth:cimd:[0-9a-f]{64}$/);
    expect(key).not.toContain('example');
  });

  it('a malformed URL is rejected without touching Redis or the network', async () => {
    const { service, redis, fetchDoc } = make();
    expect(await service.resolve('http://app.example.com/c.json')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('I-8: with the flag off nothing is read or fetched', async () => {
    const { service, redis, fetchDoc } = make({ enabled: false });
    expect(await service.resolve(URL_ID)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(fetchDoc).not.toHaveBeenCalled();
  });

  it('concurrent first requests for one URL share a single fetch', async () => {
    const { service, fetchDoc } = make();
    await Promise.all([
      service.resolve(URL_ID),
      service.resolve(URL_ID),
      service.resolve(URL_ID),
    ]);
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent outbound fetches; the overflow is refused as busy and is NOT cached', async () => {
    const { service, fetchDoc, store } = make();
    const release: (() => void)[] = [];
    fetchDoc.mockImplementation(
      (url: string) =>
        new Promise((resolve) =>
          release.push(() => resolve({ body: body({ client_id: url }) })),
        ),
    );
    const urls = Array.from(
      { length: 9 },
      (_, i) => `https://app${i}.example.com/c.json`,
    );
    const pending = urls.map((u) => service.resolve(u));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchDoc).toHaveBeenCalledTimes(8);
    expect(await pending[8]).toEqual({ ok: false, reason: 'busy' });
    release.forEach((r) => r());
    await Promise.all(pending);
    expect(store.size).toBe(8);
  });

  it('M-1: once the 8 fetches have completed, a 9th is attempted (slots are released, not leaked)', async () => {
    const { service, fetchDoc } = make();
    const release: (() => void)[] = [];
    fetchDoc.mockImplementation(
      (url: string) =>
        new Promise((resolve) =>
          release.push(() => resolve({ body: body({ client_id: url }) })),
        ),
    );
    const first = Array.from({ length: 8 }, (_, i) =>
      service.resolve(`https://app${i}.example.com/c.json`),
    );
    await new Promise((r) => setTimeout(r, 10));
    release.forEach((r) => r());
    await Promise.all(first);
    fetchDoc.mockClear();
    fetchDoc.mockResolvedValue({
      body: body({ client_id: 'https://ninth.example.com/c.json' }),
    });
    expect(
      await service.resolve('https://ninth.example.com/c.json'),
    ).toMatchObject({ ok: true });
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });

  it('M-1: slots are also released when fetches fail', async () => {
    const { service, fetchDoc } = make();
    fetchDoc.mockRejectedValue(new CimdFetchError('timeout'));
    for (let i = 0; i < 20; i++) {
      expect(await service.resolve(`https://f${i}.example.com/c.json`)).toEqual(
        {
          ok: false,
          reason: 'timeout',
        },
      );
    }
  });

  it('logs failures with host and reason only, never the URL path or a body', async () => {
    const { service, fetchDoc, logger } = make();
    fetchDoc.mockRejectedValue(new CimdFetchError('bad_status', '500'));
    await service.resolve(URL_ID);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('app.example.com');
    expect(logged).toContain('bad_status');
    expect(logged).not.toContain('/oauth/client.json');
  });

  it('peek returns only what is cached and never fetches', async () => {
    const { service, fetchDoc } = make();
    expect(await service.peek(URL_ID)).toBeNull();
    await service.resolve(URL_ID);
    expect((await service.peek(URL_ID))?.clientName).toBe('Example Agent');
    expect(fetchDoc).toHaveBeenCalledTimes(1);
  });
});
