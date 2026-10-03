// The default resolver against a REAL dns.promises.Resolver and a real UDP
// socket that swallows every query. No network leaves the machine.
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {
  CimdFetchError,
  createDnsResolver,
  fetchClientMetadataDocument,
} from './cimd-fetcher';
import type { CimdDnsResolver } from './cimd-fetcher';
import { CimdClientService } from './cimd-client.service';

let blackhole: dgram.Socket | undefined;
afterEach(() => {
  blackhole?.close();
  blackhole = undefined;
});

async function startBlackhole(): Promise<number> {
  blackhole = dgram.createSocket('udp4');
  blackhole.on('message', () => undefined); // swallow every query
  await new Promise<void>((r) => blackhole!.bind(0, '127.0.0.1', r));
  return blackhole.address().port;
}

/** A real Resolver pointed at the black hole; tracks when its lookups settle. */
function realResolverFactory(port: number) {
  const state = { pending: 0, started: 0 };
  const create = (o: { timeout: number; tries: number }): CimdDnsResolver => {
    const real = new dns.promises.Resolver(o);
    real.setServers([`127.0.0.1:${port}`]);
    const track = <T>(p: Promise<T>) => {
      state.started++;
      state.pending++;
      const done = () => void state.pending--;
      p.then(done, done);
      return p;
    };
    return {
      resolve4: (h) => track(real.resolve4(h)),
      resolve6: (h) => track(real.resolve6(h)),
      cancel: () => real.cancel(),
    };
  };
  return { create, state };
}

const URL_ID = 'https://app.example.com/oauth/client.json';

describe('the default resolver with real c-ares and real sockets', () => {
  it('a DNS server that never answers ends at the deadline, cancel() really settles the c-ares query, and the failure is transient', async () => {
    const port = await startBlackhole();
    const { create, state } = realResolverFactory(port);
    const started = Date.now();
    let error: unknown;
    try {
      await fetchClientMetadataDocument(URL_ID, {
        resolve: createDnsResolver({ create }),
        timeoutMs: 150,
      });
    } catch (e) {
      error = e;
    }
    // (a) rejected at the deadline, not at c-ares' own 1 s x 2 tries
    expect(error).toBeInstanceOf(CimdFetchError);
    expect((error as CimdFetchError).code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(900);
    // (b) the lookup had already settled when the fetch returned
    expect(state.started).toBe(2);
    expect(state.pending).toBe(0);
  });

  it('through the service the slot is free afterwards and the reason is one of the transient ones (503 path)', async () => {
    const port = await startBlackhole();
    const { create, state } = realResolverFactory(port);
    const store = new Map<string, string>();
    const redis = {
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      set: (k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      },
    };
    const service = new CimdClientService(
      redis as never,
      {
        get: (k: string) => (k === 'OAUTH_CIMD_ENABLED' ? true : undefined),
      } as never,
      { info() {}, warn() {}, debug() {} } as never,
      (url) =>
        fetchClientMetadataDocument(url, {
          resolve: createDnsResolver({ create }),
          timeoutMs: 150,
        }),
    );
    const r = await service.resolve(URL_ID);
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(state.pending).toBe(0);
    expect((service as unknown as { active: number }).active).toBe(0);
  });

  it('with a server that answers but never in time, a lookup error that is not NXDOMAIN/NODATA stays dns_unavailable (transient)', async () => {
    const port = await startBlackhole();
    const { create } = realResolverFactory(port);
    // No deadline pressure here: c-ares itself gives up (timeout 1 s x 2 is
    // too slow for a unit test, so shrink it through the factory).
    const fast = (o: { timeout: number; tries: number }) =>
      create({ ...o, timeout: 100, tries: 1 });
    const err = await createDnsResolver({ create: fast })(
      'app.example.com',
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect((err as CimdFetchError).code).toBe('dns_unavailable');
  });
});
