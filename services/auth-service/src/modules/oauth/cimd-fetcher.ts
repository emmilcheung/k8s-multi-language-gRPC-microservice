import { promises as dns } from 'node:dns';
import https from 'node:https';
import net from 'node:net';

/**
 * SSRF-safe fetcher for OAuth Client ID Metadata Documents (CIMD).
 *
 * auth-service holds the token signing key and here opens outbound HTTPS to a
 * URL chosen by an unauthenticated caller, so every step is defensive:
 * canonical https-only URL shape, DNS resolved once and every answer vetted
 * against a block list, the connection pinned to the vetted IP (no second
 * resolution, TLS still verified against the hostname), GET only, no
 * redirects, a hard byte cap enforced on bytes received, and ONE deadline
 * covering DNS, connect, TLS, headers and body. The resolver and transport are
 * injectable so tests need no network.
 */

export type CimdErrorCode =
  | 'invalid_url'
  | 'dns_failed'
  | 'dns_unavailable'
  | 'blocked_address'
  | 'connect_failed'
  | 'timeout'
  | 'redirect'
  | 'bad_status'
  | 'bad_content_type'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_document'
  | 'busy';

/** Carries a reason code only; messages never include a document body. */
export class CimdFetchError extends Error {
  constructor(
    readonly code: CimdErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CimdFetchError';
  }
}

export const CIMD_MAX_BODY_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 3000;
export const CIMD_MAX_URL_LENGTH = 512;
const USER_AGENT = 'marquee-auth-service-cimd/1.0';

export interface CimdAddress {
  address: string;
  family: number;
}
/**
 * Must honour `signal`: when it aborts (the single deadline) the lookup has to
 * stop and settle, because the caller holds its in-flight slot until it does.
 */
export type CimdResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<CimdAddress[]>;

export interface CimdTransportRequest {
  /** The vetted IP to connect to. The hostname must never be resolved again. */
  address: string;
  family: 4 | 6;
  /** Original hostname: used for SNI, certificate verification and Host. */
  hostname: string;
  path: string;
  signal: AbortSignal;
}
export interface CimdTransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Destroys the underlying socket / stream. Must be safe to call twice. */
  close(): void;
}
export type CimdTransport = (
  req: CimdTransportRequest,
) => Promise<CimdTransportResponse>;

export interface CimdFetchDeps {
  resolve: CimdResolver;
  transport: CimdTransport;
  timeoutMs: number;
}

export interface CimdFetchResult {
  body: string;
  cacheControl?: string;
}

// ---------------------------------------------------------------------------
// Address block list

const blockList = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockList.addSubnet(net4, prefix, 'ipv4');
}
blockList.addAddress('255.255.255.255', 'ipv4');
for (const [net6, prefix] of [
  // :: and ::1 plus the deprecated IPv4-compatible range (::a.b.c.d).
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  // NAT64 (RFC 6052 / 8215), SIIT (::ffff:0:a.b.c.d), Teredo and 6to4 all
  // embed an IPv4 address that could be internal: refused outright.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['::ffff:0:0:0', 96],
  ['2001::', 32],
  ['2002::', 16],
  // Deprecated site-local, discard-only, and other special-purpose ranges.
  ['fec0::', 10],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:10::', 28],
] as const) {
  blockList.addSubnet(net6, prefix, 'ipv6');
}

/**
 * True when the address must never be connected to. Fails closed: anything that
 * is not a parseable IP is blocked. IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged
 * by the embedded IPv4 address.
 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 4) return blockList.check(address, 'ipv4');
  let canonical: string;
  try {
    // WHATWG serialisation gives one canonical, compressed, hex-group form.
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blockList.check(canonical, 'ipv6');
}

// ---------------------------------------------------------------------------
// URL shape

/** Names that can only mean something inside a private network. */
const INTERNAL_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.svc',
  '.cluster.local',
  '.lan',
  '.home.arpa',
];

const DOT_SEGMENTS = new Set(['.', '..', '%2e', '%2e%2e', '.%2e', '%2e.']);

/**
 * Validates the client_id URL BEFORE any DNS. Strict: only the canonical
 * spelling is accepted (so the document's `client_id` can be compared byte for
 * byte), https only, no userinfo / query / fragment, a non-root path without dot
 * segments, a DNS-name host (no IP literals of either family) and port 443 only.
 */
export function parseClientIdUrl(raw: string): URL {
  const bad = (why: string) => new CimdFetchError('invalid_url', why);
  if (raw.length > CIMD_MAX_URL_LENGTH) throw bad('too long');
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\')) {
    throw bad('illegal characters');
  }
  if (!raw.startsWith('https://')) throw bad('must be https');
  if (raw.includes('#')) throw bad('fragment not allowed');
  if (raw.includes('?')) throw bad('query not allowed');

  const rest = raw.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) throw bad('path must not be root');
  const authority = rest.slice(0, slash);
  const rawPath = rest.slice(slash);
  if (authority.includes('@')) throw bad('userinfo not allowed');
  if (authority.startsWith('[')) throw bad('IP literal host');

  const colon = authority.indexOf(':');
  const rawHost = colon === -1 ? authority : authority.slice(0, colon);
  if (colon !== -1 && authority.slice(colon + 1) !== '443') {
    throw bad('only port 443 is allowed');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad('unparseable');
  }
  if (url.hostname !== rawHost) throw bad('host is not canonical');
  if (net.isIP(url.hostname) !== 0) throw bad('IP literal host');
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw bad('host must be a DNS name');
  }
  if (INTERNAL_SUFFIXES.some((x) => url.hostname.endsWith(x))) {
    // Refused before DNS so an attacker cannot probe internal Service names
    // through the cluster resolver.
    throw bad('internal-looking host name');
  }
  if (rawPath === '/') throw bad('path must not be root');
  if (rawPath.split('/').some((s) => DOT_SEGMENTS.has(s.toLowerCase()))) {
    throw bad('dot segments not allowed');
  }
  if (url.pathname !== rawPath) throw bad('path is not canonical');
  return url;
}

// ---------------------------------------------------------------------------
// Default seams

/** The slice of dns.promises.Resolver used here; tests inject a fake. */
export interface CimdDnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

const DNS_TIMEOUT_MS = 1000;
const DNS_TRIES = 2;
const TERMINAL_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * Resolves with c-ares (dns.promises.Resolver) instead of dns.lookup: getaddrinfo
 * runs on the libuv threadpool that argon2 sign-in shares, so slow-DNS client_id
 * URLs from unauthenticated callers could stall logins. c-ares is off the pool
 * and cancellable. A and AAAA are queried in parallel (so /etc/hosts and
 * resolv.conf search domains are not consulted, which is wanted); IPv4 comes
 * first, and every address of both families is vetted by the caller.
 */
export function createDnsResolver(
  opts: {
    create?: (o: { timeout: number; tries: number }) => CimdDnsResolver;
  } = {},
): CimdResolver {
  const create =
    opts.create ?? ((o) => new dns.Resolver(o) as unknown as CimdDnsResolver);
  return async (hostname, signal) => {
    const resolver = create({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
    const cancel = () => resolver.cancel();
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const out: CimdAddress[] = [];
      if (v4.status === 'fulfilled') {
        out.push(...v4.value.map((address) => ({ address, family: 4 })));
      }
      if (v6.status === 'fulfilled') {
        out.push(...v6.value.map((address) => ({ address, family: 6 })));
      }
      if (out.length > 0) return out;
      const codes = [v4, v6].map((r) =>
        r.status === 'rejected'
          ? String((r.reason as { code?: string }).code ?? '')
          : 'ENODATA',
      );
      throw new CimdFetchError(
        codes.every((c) => TERMINAL_DNS_CODES.has(c))
          ? 'dns_failed'
          : 'dns_unavailable',
        codes.join(','),
      );
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  };
}

const defaultResolve: CimdResolver = createDnsResolver();

/**
 * Real transport: connects to the vetted IP itself, with `servername` and
 * `Host` set to the original hostname so TLS verification stays on against the
 * name the caller asked for. A fresh agent (`agent: false`) means no keep-alive
 * pool shared with other traffic and no proxy settings; no compression is
 * requested so a small body cannot inflate past the cap.
 * `ca` and `port` exist for tests that run a local TLS server; production
 * wiring passes nothing. Certificate verification cannot be disabled here.
 */
export function createHttpsTransport(
  options: { ca?: string | Buffer; port?: number } = {},
): CimdTransport {
  return ({ address, family, hostname, path, signal }) =>
    new Promise((resolve, reject) => {
      const req = https.request({
        host: address,
        family,
        // Only the factory sets the port; the URL's port is already pinned to 443.
        port: options.port ?? 443,
        method: 'GET',
        path,
        servername: hostname,
        agent: false,
        rejectUnauthorized: true,
        ca: options.ca,
        headers: {
          Host: hostname,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
        },
      });
      const abort = () => req.destroy(new Error('aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      req.on('error', reject);
      req.on('response', (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
          close: () => {
            res.destroy();
            req.destroy();
          },
        });
      });
      req.end();
    });
}

// ---------------------------------------------------------------------------
// Fetch

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const type = value.split(';')[0].trim().toLowerCase();
  return (
    type === 'application/json' ||
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+\+json$/.test(type)
  );
}

export async function fetchClientMetadataDocument(
  rawUrl: string,
  deps: Partial<CimdFetchDeps> = {},
): Promise<CimdFetchResult> {
  const url = parseClientIdUrl(rawUrl);
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? createHttpsTransport();
  const timeoutMs = deps.timeoutMs ?? CIMD_TIMEOUT_MS;

  const ctrl = new AbortController();
  let response: CimdTransportResponse | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CimdFetchError('timeout')), timeoutMs);
  });

  // Started here (not inside `work`) so the finally below can wait for it.
  const lookup = Promise.resolve().then(() =>
    resolve(url.hostname, ctrl.signal),
  );
  const lookupSettled = lookup.then(
    () => undefined,
    () => undefined,
  );

  const work = (async (): Promise<CimdFetchResult> => {
    let answers: CimdAddress[];
    try {
      answers = await lookup;
    } catch (e) {
      if (e instanceof CimdFetchError) throw e;
      throw new CimdFetchError('dns_failed');
    }
    if (ctrl.signal.aborted) throw new CimdFetchError('timeout');
    if (answers.length === 0)
      throw new CimdFetchError('dns_failed', 'no answer');
    // One bad address condemns the whole answer: a rebinding-style record set
    // mixing public and private addresses must not be trusted.
    if (answers.some((a) => isBlockedAddress(a.address))) {
      throw new CimdFetchError('blocked_address');
    }
    // IPv4 first; connect to the first vetted address only (no fallback loop).
    const target = [...answers].sort((x, y) => x.family - y.family)[0];

    let res: CimdTransportResponse;
    try {
      res = await transport({
        address: target.address,
        family: net.isIP(target.address) === 6 ? 6 : 4,
        hostname: url.hostname,
        path: url.pathname,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof CimdFetchError) throw e;
      throw new CimdFetchError('connect_failed');
    }
    response = res;
    if (ctrl.signal.aborted) {
      // The deadline already fired: the caller's cleanup ran before this
      // response existed, so close it here instead of leaking the socket.
      res.close();
      throw new CimdFetchError('timeout');
    }

    if (res.status >= 300 && res.status < 400) {
      throw new CimdFetchError('redirect', String(res.status));
    }
    if (res.status !== 200) {
      throw new CimdFetchError('bad_status', String(res.status));
    }
    if (!isJsonContentType(res.headers['content-type'])) {
      throw new CimdFetchError('bad_content_type');
    }

    // The cap is enforced on bytes actually received; Content-Length is never trusted.
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > CIMD_MAX_BODY_BYTES) throw new CimdFetchError('too_large');
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      if (e instanceof CimdFetchError) throw e;
      throw new CimdFetchError('connect_failed', 'body stream error');
    }
    return {
      body: Buffer.concat(chunks).toString('utf8'),
      cacheControl: res.headers['cache-control'],
    };
  })();
  // If the deadline wins, `work` is abandoned; keep its later rejection quiet.
  work.catch(() => undefined);

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    response?.close();
    // Hold the caller's in-flight slot until the lookup has really settled
    // (abort cancels the c-ares query, so this is prompt).
    await lookupSettled;
  }
}
