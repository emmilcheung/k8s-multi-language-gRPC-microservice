import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as ClientV2,
  StreamableHTTPClientTransport as TransportV2,
} from '@modelcontextprotocol/client';
import type { Logger } from 'pino';
import { createApp } from './app.ts';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from 'jose';
import type { Config } from './config.ts';

export const testConfig: Config = {
  PORT: 3000,
  LOG_LEVEL: 'silent',
  MCP_RESOURCE: 'http://localhost:8000/mcp',
  OAUTH_ISSUER: 'http://localhost:8000',
  AUTH_JWKS_URL: 'http://auth-service:3000/.well-known/jwks.json',
  KONG_INTERNAL_URL: 'http://kong:8000',
  TOKEN_EXCHANGE_URL: 'http://auth-service:3000/oauth/token',
  TOKEN_EXCHANGE_CLIENT_ID: 'mcp-service',
  TOKEN_EXCHANGE_CLIENT_SECRET: 'test-only-not-a-real-secret',
  PUBLIC_WEB_URL: 'http://localhost:3000',
};

const { publicKey, privateKey } = await generateKeyPair('RS256');
const { privateKey: otherPrivateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };

/** Stub JWKS holding only the test key; stands in for auth-service's endpoint. */
export const stubJwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

interface MintOptions {
  iss?: string;
  aud?: string;
  scope?: string;
  clientId?: string | null;
  sub?: string;
  expiresIn?: string;
  /** Sign with HS256 instead of the RSA key (algorithm-confusion attempt). */
  hs256?: boolean;
  /** Sign with a different RSA key that reuses the published `kid` (forgery). */
  wrongKey?: boolean;
}

/** Secret an attacker would use for HS256; a permissive resolver may return it. */
export const hmacSecret = new TextEncoder().encode(
  'an-hs256-secret-of-sufficient-length!!',
);

/** Resolver that hands back the HMAC secret for any header, so only the alg allowlist can reject HS256. */
export const permissiveHmacJwks: JWTVerifyGetKey = () =>
  Promise.resolve(hmacSecret);

/** Unsecured JWT (`alg: none`, empty signature) with otherwise valid claims. */
export function mintUnsecuredToken(): string {
  const b64 = (o: object): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: testConfig.OAUTH_ISSUER,
    aud: testConfig.MCP_RESOURCE,
    sub: 'user-1',
    client_id: 'test-client',
    scope: 'tickets:read',
    iat: now,
    exp: now + 300,
  })}.`;
}

/** Mints a C-1 "MCP token" shape by default; override one claim per test. */
export async function mintToken(opts: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    scope: opts.scope ?? 'tickets:read',
    ...(opts.clientId === null
      ? {}
      : { client_id: opts.clientId ?? 'test-client' }),
  })
    .setSubject(opts.sub ?? 'user-1')
    .setIssuer(opts.iss ?? testConfig.OAUTH_ISSUER)
    .setAudience(opts.aud ?? testConfig.MCP_RESOURCE)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(opts.expiresIn ?? '5m');
  if (opts.hs256) {
    return jwt
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .sign(hmacSecret);
  }
  return jwt
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(opts.wrongKey ? otherPrivateKey : privateKey);
}

export interface UpstreamCall {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

/** App wired to a stub exchange endpoint and a stub Kong; nothing leaves the process. */
export const DEFAULT_PAYMENT_METHOD = '44444444-4444-4444-8444-444444444444';

/**
 * Upstream replies in the shapes the real services emit (order-service
 * OrderResponse, payment-service controller, ticket-service ticketResponse,
 * venue-service AvailabilitySnapshot), chosen by method and path.
 */
export function realisticReply(call: UpstreamCall): Response {
  const { pathname } = call.url;
  const order = {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'PENDING',
    quantity: 2,
    total: '120.00',
    expiresAt: '2026-10-02T12:15:00Z',
    orderType: 'GA',
    planId: null,
    ticket: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Concert',
      price: 60,
      startsAt: '2026-11-01T19:00:00Z',
    },
    seats: [],
  };
  const ticket = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Concert',
    price: '60.00',
    quota: 100,
    reserved: 0,
    sold: 10,
  };
  const payment = {
    id: '55555555-5555-4555-8555-555555555555',
    orderId: order.id,
    status: 'completed',
    amount: 12000,
    currency: 'usd',
  };
  if (pathname === '/api/tickets') return Response.json([ticket]);
  if (pathname.startsWith('/api/tickets/')) return Response.json(ticket);
  if (pathname.endsWith('/availability')) {
    return Response.json({
      planId: pathname.split('/')[3],
      seatMap: { s1: { status: 'AVAILABLE' } },
      counts: { AVAILABLE: 1 },
    });
  }
  if (pathname === '/api/orders' && call.method === 'GET') {
    return Response.json([order]);
  }
  if (pathname.startsWith('/api/orders')) return Response.json(order);
  if (pathname === '/api/payments/methods') {
    return Response.json({
      paymentMethods: [
        {
          id: DEFAULT_PAYMENT_METHOD,
          brand: 'visa',
          last4: '4242',
          expMonth: 1,
          expYear: 2030,
          isDefault: true,
          label: 'VISA 4242',
        },
      ],
    });
  }
  if (pathname.startsWith('/api/payments')) return Response.json({ payment });
  return Response.json({}, { status: 404 });
}

export interface HarnessOptions {
  /** Replaces the token-exchange endpoint's reply. */
  exchange?: () => Response | Promise<Response>;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

export function harness(
  respond: (call: UpstreamCall) => Response = realisticReply,
  opts: HarnessOptions = {},
) {
  const calls: UpstreamCall[] = [];
  /** Form of every token-exchange request (C-5), in order. */
  const exchanges: URLSearchParams[] = [];
  const stubFetch: typeof fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.href === testConfig.TOKEN_EXCHANGE_URL) {
      exchanges.push(
        new URLSearchParams((init?.body as URLSearchParams).toString()),
      );
      if (opts.exchange) return Promise.resolve(opts.exchange());
      return Promise.resolve(
        Response.json({
          access_token: 'api-audience-token',
          token_type: 'Bearer',
          expires_in: 300,
        }),
      );
    }
    const call: UpstreamCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  const app = createApp({
    config: testConfig,
    jwks: stubJwks,
    logger: opts.logger,
    fetch: stubFetch,
  });
  const responses: Response[] = [];
  const viaApp: typeof fetch = async (input, init) => {
    const res = await app(new Request(input, init));
    responses.push(res.clone());
    return res;
  };
  return { calls, exchanges, responses, viaApp };
}

export type Era = 'legacy 2025-11-25' | 'modern 2026-07-28';
export const ERAS: Era[] = ['legacy 2025-11-25', 'modern 2026-07-28'];

export async function connect(era: Era, token: string, fetchFn: typeof fetch) {
  const url = new URL(testConfig.MCP_RESOURCE);
  const requestInit = { headers: { authorization: `Bearer ${token}` } };
  if (era === 'legacy 2025-11-25') {
    const client = new ClientV1({ name: 'v1', version: '0' });
    await client.connect(new TransportV1(url, { fetch: fetchFn, requestInit }));
    return client as unknown as CommonClient;
  }
  const client = new ClientV2(
    { name: 'v2', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(new TransportV2(url, { fetch: fetchFn, requestInit }));
  return client as unknown as CommonClient;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}
export interface CommonClient {
  listTools(): Promise<{
    tools: {
      name: string;
      annotations?: Record<string, unknown>;
      inputSchema: { properties?: Record<string, unknown> };
      outputSchema?: unknown;
    }[];
  }>;
  callTool(req: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ToolResult>;
  close(): Promise<void>;
}
