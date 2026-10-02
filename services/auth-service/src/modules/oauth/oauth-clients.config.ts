import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import type { OAuthScope } from './oauth-scopes';

export type { OAuthScope };

/** RFC 7591 application_type (D12 / WS-I). */
export type OAuthApplicationType = 'native' | 'web';

/** How a client became known: static config, dynamic registration, or a CIMD URL. */
export type OAuthClientSource = 'static' | 'dynamic' | 'cimd';

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  pkceRequired: boolean;
  allowedScopes: OAuthScope[];
  accessTokenLifetimeSeconds: number;
  refreshTokenLifetimeSeconds: number;
  isFirstParty?: boolean;
  /** Absent means a static config entry. */
  source?: OAuthClientSource;
  applicationType?: OAuthApplicationType;
}

export const OAUTH_CLIENTS: OAuthClient[] = [
  {
    clientId: 'ticketing-mcp',
    clientName: 'Ticketing MCP Server',
    redirectUris: ['http://127.0.0.1:19836/callback'],
    grantTypes: ['authorization_code'],
    pkceRequired: true,
    allowedScopes: [...OAUTH_SCOPE_NAMES],
    accessTokenLifetimeSeconds: 900,
    refreshTokenLifetimeSeconds: 24 * 60 * 60,
  },
];

/**
 * The confidential client allowed to use the RFC 8693 token-exchange grant
 * (C-5). Deliberately NOT in OAUTH_CLIENTS: it has no redirect URIs and no
 * authorization_code/refresh flow, so it must never resolve at /authorize or
 * as a session owner. Its secret hash comes from config, never from source.
 */
export const MCP_SERVICE_CLIENT_ID = 'mcp-service';
export const TOKEN_EXCHANGE_GRANT =
  'urn:ietf:params:oauth:grant-type:token-exchange';

export function findClient(clientId: string): OAuthClient | undefined {
  return OAUTH_CLIENTS.find((c) => c.clientId === clientId);
}

export function validateScopes(
  requestedScopes: string[],
  client: OAuthClient,
): OAuthScope[] {
  const allowed = new Set<string>(client.allowedScopes);
  return requestedScopes.filter((s): s is OAuthScope => allowed.has(s));
}

/** Adapter: converts a DynamicOAuthClient to the shape OAuthService expects. */
export function dynamicToStaticShape(
  dynamic: import('./dynamic-client.service.js').DynamicOAuthClient,
): OAuthClient {
  return {
    clientId: dynamic.clientId,
    clientName: dynamic.clientName,
    redirectUris: dynamic.redirectUris,
    grantTypes: dynamic.grantTypes,
    allowedScopes: dynamic.allowedScopes.filter((s): s is OAuthScope =>
      (OAUTH_SCOPE_NAMES as readonly string[]).includes(s),
    ),
    pkceRequired: dynamic.pkceRequired,
    accessTokenLifetimeSeconds: dynamic.accessTokenLifetimeSeconds,
    refreshTokenLifetimeSeconds: dynamic.refreshTokenLifetimeSeconds,
    isFirstParty: false,
    source: 'dynamic',
    applicationType: dynamic.applicationType ?? 'web',
  };
}
