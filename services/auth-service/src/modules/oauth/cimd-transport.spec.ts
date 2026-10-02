/* eslint-disable @typescript-eslint/require-await -- async fakes stand in for network seams */
// R3: the real transport over real sockets. A local https server on 127.0.0.1
// with a throwaway self-signed cert (generated here with the openssl CLI into a
// temp dir; nothing is committed) stands in for the client's host. The hostname
// app.example.com does not resolve anywhere, so any test that passes proves the
// transport connected to the pinned IP and not to the name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIMD_MAX_BODY_BYTES,
  CimdFetchError,
  createHttpsTransport,
  fetchClientMetadataDocument,
} from './cimd-fetcher';
import type { CimdResolver, CimdTransport } from './cimd-fetcher';

const HOST = 'app.example.com';
const URL_OK = `https://${HOST}/oauth/client.json`;
const PUBLIC_IP = '93.184.216.34';
// The resolver says a public IP (the guard would refuse 127.0.0.1); the wrapped
// transport then dials the local server instead, exactly as a pinned IP would.
const publicResolver: CimdResolver = async () => [
  { address: PUBLIC_IP, family: 4 },
];

let dir: string;
function makeCert(name: string): { key: string; cert: string } {
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, `${name}.key`),
        '-out',
        join(dir, `${name}.crt`),
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    throw new Error(
      `R3 needs the openssl CLI on PATH to generate a throwaway test certificate: ${String(e)}`,
    );
  }
  return {
    key: readFileSync(join(dir, `${name}.key`), 'utf8'),
    cert: readFileSync(join(dir, `${name}.crt`), 'utf8'),
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface Seen {
  host?: string;
  acceptEncoding?: string;
  servername?: string;
  method?: string;
  path?: string;
}

async function serve(
  creds: { key: string; cert: string },
  handler: Handler,
  seen: Seen = {},
) {
  const server = https.createServer(creds, (req, res) => {
    seen.host = req.headers.host;
    seen.acceptEncoding = req.headers['accept-encoding'];
    seen.method = req.method;
    seen.path = req.url;
    handler(req, res);
  });
  server.on('secureConnection', (s) => {
    seen.servername = (s as unknown as { servername?: string }).servername;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

let good: { key: string; cert: string };
let other: { key: string; cert: string };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cimd-tls-'));
  good = makeCert(HOST);
  other = makeCert('other.example.com');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Real transport, dialing the local server in place of the vetted public IP. */
function toLocal(port: number, extra: Record<string, unknown> = {}) {
  const real = createHttpsTransport({
    ca: good.cert,
    port,
    ...extra,
  } as never);
  const t: CimdTransport = (req) => real({ ...req, address: '127.0.0.1' });
  return t;
}

const json =
  (body: string): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CimdFetchError) return e.code;
    throw e;
  }
  return 'resolved';
}

describe('R3: createHttpsTransport over real sockets', () => {
  it('R3: connects to the pinned IP (the hostname does not resolve) while SNI and Host carry the hostname; a 200 JSON body round-trips', async () => {
    const srv = await serve(good, json('{"client_id":"x"}'));
    try {
      const out = await fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport: toLocal(srv.port),
      });
      expect(out.body).toBe('{"client_id":"x"}');
      expect(srv.seen.servername).toBe(HOST);
      expect(srv.seen.host).toBe(HOST);
      expect(srv.seen.method).toBe('GET');
      expect(srv.seen.path).toBe('/oauth/client.json');
    } finally {
      srv.close();
    }
  });

  it('R3: a certificate for a different name is rejected (TLS verification is on)', async () => {
    const srv = await serve(other, json('{}'));
    try {
      const real = createHttpsTransport({ ca: other.cert, port: srv.port });
      const t: CimdTransport = (req) => real({ ...req, address: '127.0.0.1' });
      expect(
        await code(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport: t,
          }),
        ),
      ).toBe('connect_failed');
    } finally {
      srv.close();
    }
  });

  it('R3: rejectUnauthorized cannot be switched off through the factory options', async () => {
    const srv = await serve(other, json('{}'));
    try {
      const t = toLocal(srv.port, {
        rejectUnauthorized: false,
        ca: other.cert,
      });
      expect(
        await code(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport: t,
          }),
        ),
      ).toBe('connect_failed');
    } finally {
      srv.close();
    }
  });

  it('R3: asks for identity encoding only', async () => {
    const srv = await serve(good, json('{}'));
    try {
      await fetchClientMetadataDocument(URL_OK, {
        resolve: publicResolver,
        transport: toLocal(srv.port),
      });
      expect(srv.seen.acceptEncoding).toBe('identity');
    } finally {
      srv.close();
    }
  });

  it('R3: a real oversize body is cut at the 5 KB cap', async () => {
    const srv = await serve(good, (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(CIMD_MAX_BODY_BYTES + 100));
      res.end();
    });
    try {
      expect(
        await code(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport: toLocal(srv.port),
          }),
        ),
      ).toBe('too_large');
    } finally {
      srv.close();
    }
  });

  it('R3: a slow-drip body (chunk every ~30 ms) is cut by the one deadline', async () => {
    let timer: NodeJS.Timeout;
    const srv = await serve(good, (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      timer = setInterval(() => res.write(' '), 30);
      res.on('close', () => clearInterval(timer));
    });
    try {
      const started = Date.now();
      expect(
        await code(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport: toLocal(srv.port),
            timeoutMs: 300,
          }),
        ),
      ).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      srv.close();
    }
  });

  it('R3: a 3xx is reported and never followed', async () => {
    let followed = false;
    const srv = await serve(good, (req, res) => {
      if (req.url === '/elsewhere') followed = true;
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    try {
      expect(
        await code(
          fetchClientMetadataDocument(URL_OK, {
            resolve: publicResolver,
            transport: toLocal(srv.port),
          }),
        ),
      ).toBe('redirect');
      expect(followed).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('R3: the port is settable only through the factory, never from the URL (a :8443 URL is refused before any socket)', async () => {
    expect(
      await code(
        fetchClientMetadataDocument(`https://${HOST}:8443/c.json`, {
          resolve: publicResolver,
        }),
      ),
    ).toBe('invalid_url');
  });
});
