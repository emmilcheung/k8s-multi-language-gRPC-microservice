/* eslint-disable @typescript-eslint/require-await -- async fakes stand in for network seams */
import { describe, it, expect, vi } from 'vitest';
import {
  CimdFetchError,
  createDnsResolver,
  fetchClientMetadataDocument,
  isBlockedAddress,
  parseClientIdUrl,
} from './cimd-fetcher';
import type {
  CimdDnsResolver,
  CimdResolver,
  CimdTransport,
  CimdTransportResponse,
} from './cimd-fetcher';

const URL_OK = 'https://app.example.com/oauth/client.json';
const PUBLIC_IP = '93.184.216.34';

const publicResolver: CimdResolver = async () => [
  { address: PUBLIC_IP, family: 4 },
];

interface FakeOpts {
  status?: number;
  headers?: Record<string, string>;
  chunks?: (string | Buffer)[];
  /** When set the body never yields, to model a slow-loris server. */
  hang?: boolean;
}

function fakeTransport(opts: FakeOpts = {}) {
  const close = vi.fn();
  const transport = vi.fn<CimdTransport>(async () => {
    const res: CimdTransportResponse = {
      status: opts.status ?? 200,
      headers: opts.headers ?? { 'content-type': 'application/json' },
      body: (async function* () {
        if (opts.hang) await new Promise(() => {});
        for (const c of opts.chunks ?? ['{}']) yield Buffer.from(c);
      })(),
      close,
    };
    return res;
  });
  return { transport, close };
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CimdFetchError) return e.code;
    throw e;
  }
  return 'resolved';
}

describe('I-1: SSRF address guard', () => {
  it('I-1: https://169.254.169.254/... (cloud metadata) is rejected before any DNS or connection', async () => {
    const resolve = vi.fn(publicResolver);
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument('https://169.254.169.254/latest/meta', {
        resolve,
        transport,
      }),
    );
    expect(code).toBe('invalid_url');
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-1: https://10.0.0.1/... (RFC 1918 literal) is rejected before any DNS or connection', async () => {
    const resolve = vi.fn(publicResolver);
    const { transport } = fakeTransport();
    expect(
      await reason(
        fetchClientMetadataDocument('https://10.0.0.1/c.json', {
          resolve,
          transport,
        }),
      ),
    ).toBe('invalid_url');
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-1: a hostname that resolves to 127.0.0.1 is rejected and never connected to', async () => {
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        transport,
      }),
    );
    expect(code).toBe('blocked_address');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    // IPv4-mapped IPv6 is judged by the embedded IPv4 address.
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '2002:7f00:1::1',
  ])('I-1: %s is blocked', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '198.20.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('I-1: %s (public) is allowed', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('I-9: rejected before any connection is attempted', () => {
  const cases: [string, string][] = [
    ['an IP-literal host (v4)', 'https://93.184.216.34/c.json'],
    ['an IP-literal host (v6)', 'https://[2606:4700::1111]/c.json'],
    ['a decimal-encoded IPv4 host', 'https://2130706433/c.json'],
    ['an IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/c.json'],
    ['a non-443 port', 'https://app.example.com:8443/c.json'],
    ['userinfo', 'https://user:pw@app.example.com/c.json'],
    ['empty userinfo', 'https://@app.example.com/c.json'],
    ['a .. path segment', 'https://app.example.com/a/../c.json'],
    ['an encoded .. segment', 'https://app.example.com/a/%2e%2e/c.json'],
    ['a . path segment', 'https://app.example.com/./c.json'],
    ['a backslash', 'https://app.example.com/a\\c.json'],
    ['a query string', 'https://app.example.com/c.json?x=1'],
    ['an empty query string', 'https://app.example.com/c.json?'],
    ['a fragment', 'https://app.example.com/c.json#frag'],
    ['a single-label host', 'https://intranet/c.json'],
    ['an uppercase host (not canonical)', 'https://App.Example.com/c.json'],
    ['an over-long URL', `https://app.example.com/${'a'.repeat(600)}`],
    ['whitespace', 'https://app.example.com/a b.json'],
  ];
  it.each(cases)('I-9: %s', async (_name, url) => {
    const resolve = vi.fn(publicResolver);
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(url, { resolve, transport }),
    );
    expect(code).toBe('invalid_url');
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-9: an answer with one public and one private address is rejected (any blocked address fails the lot)', async () => {
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: async () => [
          { address: PUBLIC_IP, family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
        transport,
      }),
    );
    expect(code).toBe('blocked_address');
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-9: an IPv4-mapped IPv6 answer for a private IPv4 is rejected', async () => {
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: async () => [{ address: '::ffff:192.168.0.10', family: 6 }],
        transport,
      }),
    );
    expect(code).toBe('blocked_address');
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-9: an empty DNS answer and a resolver error are both rejected', async () => {
    const { transport } = fakeTransport();
    expect(
      await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: async () => [],
          transport,
        }),
      ),
    ).toBe('dns_failed');
    expect(
      await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: async () => {
            throw new Error('ENOTFOUND');
          },
          transport,
        }),
      ),
    ).toBe('dns_failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('I-9: parseClientIdUrl accepts the canonical form (explicit :443 allowed)', () => {
    expect(parseClientIdUrl(URL_OK).hostname).toBe('app.example.com');
    expect(
      parseClientIdUrl('https://app.example.com:443/c.json').hostname,
    ).toBe('app.example.com');
  });
});

describe('connection pinning', () => {
  it('I-1: the transport is called with the vetted IP and the original hostname for SNI/Host, never the hostname as the address', async () => {
    const resolve = vi.fn(publicResolver);
    const { transport } = fakeTransport();
    await fetchClientMetadataDocument(URL_OK, { resolve, transport });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toMatchObject({
      address: PUBLIC_IP,
      family: 4,
      hostname: 'app.example.com',
      path: '/oauth/client.json',
    });
  });
});

describe('I-2: redirects', () => {
  it.each([301, 302, 303, 307, 308])(
    'I-2: a %i response is rejected and not followed',
    async (status) => {
      const { transport, close } = fakeTransport({
        status,
        headers: { location: 'https://169.254.169.254/' },
      });
      const code = await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: publicResolver,
          transport,
        }),
      );
      expect(code).toBe('redirect');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalled();
    },
  );
});

describe('I-3: size cap', () => {
  it('I-3: a body over 5 KB is rejected on bytes received, whatever Content-Length says', async () => {
    const { transport, close } = fakeTransport({
      headers: { 'content-type': 'application/json', 'content-length': '10' },
      chunks: ['{"a":"', 'x'.repeat(3000), 'x'.repeat(3000), '"}'],
    });
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport,
      }),
    );
    expect(code).toBe('too_large');
    expect(close).toHaveBeenCalled();
  });

  it('I-3: a body of exactly 5 KB is accepted', async () => {
    const { transport } = fakeTransport({ chunks: ['x'.repeat(5120)] });
    const res = await fetchClientMetadataDocument(URL_OK, {
      resolve: publicResolver,
      transport,
    });
    expect(res.body).toHaveLength(5120);
  });
});

describe('I-11: response validation closes the socket', () => {
  it('I-11: a non-JSON content type is rejected and the stream is closed', async () => {
    const { transport, close } = fakeTransport({
      headers: { 'content-type': 'text/html' },
    });
    expect(
      await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: publicResolver,
          transport,
        }),
      ),
    ).toBe('bad_content_type');
    expect(close).toHaveBeenCalled();
  });

  it('I-11: application/json with a charset and a +json suffix type are accepted', async () => {
    for (const ct of [
      'application/json; charset=utf-8',
      'application/client-metadata+json',
      'Application/JSON',
    ]) {
      const { transport } = fakeTransport({ headers: { 'content-type': ct } });
      const res = await fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport,
      });
      expect(res.body).toBe('{}');
    }
  });

  it('I-11: a missing content type is rejected', async () => {
    const { transport } = fakeTransport({ headers: {} });
    expect(
      await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: publicResolver,
          transport,
        }),
      ),
    ).toBe('bad_content_type');
  });

  it.each([204, 404, 500])(
    'I-11: status %i is rejected and the stream is closed',
    async (status) => {
      const { transport, close } = fakeTransport({ status });
      expect(
        await reason(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport,
          }),
        ),
      ).toBe('bad_status');
      expect(close).toHaveBeenCalled();
    },
  );

  it('I-11: a body that never finishes hits the single 3 s deadline (shortened here) and the stream is closed', async () => {
    const { transport, close } = fakeTransport({ hang: true });
    const started = Date.now();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport,
        timeoutMs: 60,
      }),
    );
    expect(code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(close).toHaveBeenCalled();
  });

  it('I-11: the deadline also covers DNS, and a transport that connects after it is closed', async () => {
    const { transport, close } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve([{ address: PUBLIC_IP, family: 4 }]), 120),
          ),
        transport,
        timeoutMs: 40,
      }),
    );
    expect(code).toBe('timeout');
    await new Promise((r) => setTimeout(r, 200));
    // The late resolver answer must not lead to a connection after the deadline.
    expect(transport).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('I-11: a transport that answers after the deadline is closed, not leaked', async () => {
    const close = vi.fn();
    const transport: CimdTransport = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: (async function* () {
                yield Buffer.from('{}');
              })(),
              close,
            }),
          120,
        ),
      );
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport,
        timeoutMs: 40,
      }),
    );
    expect(code).toBe('timeout');
    await new Promise((r) => setTimeout(r, 200));
    expect(close).toHaveBeenCalled();
  });

  it('I-11: a transport error (connect / TLS failure) is reported as connect_failed', async () => {
    const transport: CimdTransport = async () => {
      throw new Error('CERT_HAS_EXPIRED');
    };
    expect(
      await reason(
        fetchClientMetadataDocument(URL_OK, {
          resolve: publicResolver,
          transport,
        }),
      ),
    ).toBe('connect_failed');
  });
});

describe('R2: DNS runs on c-ares (dns.promises.Resolver), not the libuv threadpool', () => {
  function fakeDns(opts: {
    v4?: string[] | Error;
    v6?: string[] | Error;
    hang?: boolean;
  }) {
    let rejectAll: (e: Error) => void = () => undefined;
    const hung = new Promise<string[]>((_, rej) => {
      rejectAll = rej;
    });
    hung.catch(() => undefined);
    const cancel = vi.fn(() => rejectAll(codeErr('ECANCELLED')));
    const answer = (v: string[] | Error | undefined) =>
      opts.hang
        ? hung
        : v instanceof Error
          ? Promise.reject(v)
          : Promise.resolve(v ?? []);
    const dns: CimdDnsResolver = {
      resolve4: vi.fn(async () => answer(opts.v4)),
      resolve6: vi.fn(async () => answer(opts.v6)),
      cancel,
    };
    return { dns, cancel };
  }
  const codeErr = (code: string) =>
    Object.assign(new Error(code), { code }) as Error;
  const ctl = () => new AbortController().signal;

  it('R2: queries A and AAAA and returns IPv4 first', async () => {
    const { dns } = fakeDns({ v4: ['93.184.216.34'], v6: ['2606:4700::1111'] });
    const out = await createDnsResolver({ create: () => dns })(
      'a.example',
      ctl(),
    );
    expect(out).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('R2: ENODATA on one family is tolerated when the other answers', async () => {
    const { dns } = fakeDns({
      v4: codeErr('ENODATA'),
      v6: ['2606:4700::1111'],
    });
    const out = await createDnsResolver({ create: () => dns })(
      'a.example',
      ctl(),
    );
    expect(out).toEqual([{ address: '2606:4700::1111', family: 6 }]);
  });

  it('R2: ENOTFOUND/ENODATA on both is a terminal dns_failed', async () => {
    const { dns } = fakeDns({
      v4: codeErr('ENOTFOUND'),
      v6: codeErr('ENODATA'),
    });
    const e = await createDnsResolver({ create: () => dns })(
      'a.example',
      ctl(),
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'dns_failed' });
  });

  it('R2: a timeout or server failure is dns_unavailable (transient), never dns_failed', async () => {
    for (const c of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
      const { dns } = fakeDns({ v4: codeErr(c), v6: codeErr('ENODATA') });
      const e = await createDnsResolver({ create: () => dns })(
        'a.example',
        ctl(),
      ).catch((x: unknown) => x);
      expect(e, c).toMatchObject({ code: 'dns_unavailable' });
    }
  });

  it('R2: a blocked address in EITHER family rejects the whole answer, with no connection', async () => {
    const { dns } = fakeDns({ v4: ['93.184.216.34'], v6: ['fd00::1'] });
    const { transport } = fakeTransport();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: createDnsResolver({ create: () => dns }),
        transport,
      }),
    );
    expect(code).toBe('blocked_address');
    expect(transport).not.toHaveBeenCalled();
  });

  it('R2: the connection goes to the first IPv4 address even when the resolver listed IPv6 first', async () => {
    const { transport } = fakeTransport();
    await fetchClientMetadataDocument(URL_OK, {
      resolve: async () => [
        { address: '2606:4700::1111', family: 6 },
        { address: PUBLIC_IP, family: 4 },
      ],
      transport,
    });
    expect(transport.mock.calls[0][0]).toMatchObject({
      address: PUBLIC_IP,
      family: 4,
    });
  });

  it('R2: the deadline cancels the c-ares query and the fetch only returns once the lookup has settled', async () => {
    const { dns, cancel } = fakeDns({ hang: true });
    const { transport } = fakeTransport();
    const started = Date.now();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: createDnsResolver({ create: () => dns }),
        transport,
        timeoutMs: 50,
      }),
    );
    expect(code).toBe('timeout');
    expect(cancel).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(transport).not.toHaveBeenCalled();
  });

  it('R2: the resolver is cancelled in finally on success too, so nothing lingers', async () => {
    const { dns, cancel } = fakeDns({ v4: ['93.184.216.34'] });
    await createDnsResolver({ create: () => dns })('a.example', ctl());
    expect(cancel).toHaveBeenCalled();
  });

  it('R2: c-ares timeout and tries are set so one lookup cannot outlive the deadline', () => {
    let seen: { timeout?: number; tries?: number } | undefined;
    const { dns } = fakeDns({ v4: ['93.184.216.34'] });
    void createDnsResolver({
      create: (o) => {
        seen = o;
        return dns;
      },
    })('a.example', ctl());
    expect(seen!.timeout! * seen!.tries!).toBeLessThanOrEqual(3000);
  });
});

describe('M-5: wider block list and early reject of internal-looking names', () => {
  it.each(['fec0::1', '100::1', '192.88.99.1', '2001:2::1', '2001:10::1'])(
    'M-5: %s is blocked',
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );

  it.each([
    'https://foo.internal/a.json',
    'https://foo.local/a.json',
    'https://foo.localhost/a.json',
    'https://my.svc/a.json',
    'https://x.svc.cluster.local/a.json',
    'https://nas.lan/a.json',
    'https://x.home.arpa/a.json',
  ])('M-5: %s is rejected before any DNS', async (u) => {
    const resolve = vi.fn(publicResolver);
    const code = await reason(
      fetchClientMetadataDocument(u, {
        resolve,
        transport: fakeTransport().transport,
      }),
    );
    expect(code).toBe('invalid_url');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('M-1 (fetcher level): the one deadline also cuts a slow drip', () => {
  it('M-1: a body that drips a chunk every 30 ms is cut by the single deadline, not reset per chunk', async () => {
    const close = vi.fn();
    const transport: CimdTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 30));
          yield Buffer.from(' ');
        }
      })(),
      close,
    });
    const started = Date.now();
    const code = await reason(
      fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport,
        timeoutMs: 120,
      }),
    );
    expect(code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(600);
    expect(close).toHaveBeenCalled();
  });
});
