import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
  type AuthMetadataOptions,
} from '@modelcontextprotocol/server';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { createTokenExchange } from './exchange.ts';
import { createMcpServer } from './server.ts';
import { createUpstream } from './upstream.ts';
import { createVerifier } from './verifier.ts';

/** every scope a client may request. The registry lives in auth-service. */
export const SCOPES_SUPPORTED = [
  'tickets:read',
  'seating:read',
  'orders:read',
  'orders:create',
  'orders:cancel',
  'payments:read',
  'payments:create',
];

/** scopes advertised in the initial 401 challenge (read-only bundle). */
const INITIAL_CHALLENGE_SCOPES = [
  'tickets:read',
  'seating:read',
  'orders:read',
  'payments:read',
];

interface AppOptions {
  config: Config;
  jwks: JWTVerifyGetKey;
  logger?: Pick<Logger, 'warn' | 'error'>;
  /** Outbound HTTP (token exchange + Kong); injectable so tests stay in-process. */
  fetch?: typeof fetch;
}

export type FetchApp = (request: Request) => Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

export function createApp({
  config,
  jwks,
  logger,
  fetch: outboundFetch,
}: AppOptions): FetchApp {
  const resource = new URL(config.MCP_RESOURCE);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const issuer = config.OAUTH_ISSUER.replace(/\/$/, '');

  // The SDK requires AS metadata to build the PRM; only the PRM path is routed
  // to it below, so auth-service stays the sole publisher of this document.
  const metadataOptions: AuthMetadataOptions = {
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ['code'],
    },
    resourceServerUrl: resource,
    scopesSupported: SCOPES_SUPPORTED,
    resourceName: 'Ticketing',
  };
  // Fail at startup on a misconfigured issuer rather than on first request.
  oauthMetadataResponse(new Request(resourceMetadataUrl), metadataOptions);

  const verifier = createVerifier({
    issuer: config.OAUTH_ISSUER,
    resource: config.MCP_RESOURCE,
    jwks,
  });
  const upstream = createUpstream({
    baseUrl: config.KONG_INTERNAL_URL,
    exchange: createTokenExchange({
      url: config.TOKEN_EXCHANGE_URL,
      clientId: config.TOKEN_EXCHANGE_CLIENT_ID,
      clientSecret: config.TOKEN_EXCHANGE_CLIENT_SECRET,
      // the API audience, as auth-service derives it (`<origin>/api`).
      resource: config.API_AUDIENCE ?? `${resource.origin}/api`,
      fetch: outboundFetch,
    }),
    fetch: outboundFetch,
    logger,
  });
  const mcp = createMcpHandler(
    () =>
      createMcpServer({
        upstream,
        publicWebUrl: config.PUBLIC_WEB_URL,
        logger,
      }),
    {
      onerror: (err) => logger?.error({ err }, 'mcp handler error'),
    },
  );

  async function protectedResourceMetadata(
    request: Request,
  ): Promise<Response | undefined> {
    const res = oauthMetadataResponse(request, metadataOptions);
    if (!res || request.method !== 'GET' || res.status !== 200) return res;
    // The SDK omits bearer_methods_supported, which the spec requires.
    const body = (await res.json()) as Record<string, unknown>;
    return Response.json(
      { ...body, bearer_methods_supported: ['header'] },
      { headers: res.headers },
    );
  }

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') return json({ status: 'ok' });

    if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return (await protectedResourceMetadata(request)) ?? json({}, 404);
    }

    if (pathname === resource.pathname) {
      let authInfo;
      try {
        authInfo = await verifyBearerToken(
          request.headers.get('authorization'),
          { verifier, resourceMetadataUrl },
        );
      } catch (err) {
        const res = bearerAuthChallengeResponse(err, {
          requiredScopes: INITIAL_CHALLENGE_SCOPES,
          resourceMetadataUrl,
        });
        if (res.status === 401) {
          logger?.warn(
            { reason: err instanceof Error ? err.message : 'unknown' },
            'mcp request rejected',
          );
        } else {
          logger?.error({ err }, 'mcp auth failure');
        }
        return res;
      }
      return mcp.fetch(request, { authInfo });
    }

    return json({ error: 'not_found' }, 404);
  };
}
