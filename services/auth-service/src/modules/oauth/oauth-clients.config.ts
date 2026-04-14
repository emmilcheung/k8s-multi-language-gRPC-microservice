export const OAUTH_SCOPES = [
  'tickets:read',
  'orders:read',
  'orders:create',
  'orders:cancel',
  'payments:read',
  'payments:create',
  'venues:read',
  'seating:read',
  'seating:hold',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  pkceRequired: boolean;
  allowedScopes: OAuthScope[];
  accessTokenLifetimeSeconds: number;
  refreshTokenLifetimeSeconds: number;
}

export const OAUTH_CLIENTS: OAuthClient[] = [
  {
    clientId: 'ticketing-mcp',
    clientName: 'Ticketing MCP Server',
    redirectUris: ['http://127.0.0.1:19836/callback'],
    grantTypes: ['authorization_code'],
    pkceRequired: true,
    allowedScopes: [...OAUTH_SCOPES],
    accessTokenLifetimeSeconds: 900,
    refreshTokenLifetimeSeconds: 24 * 60 * 60,
  },
];

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
