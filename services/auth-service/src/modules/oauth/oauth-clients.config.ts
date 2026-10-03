import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import type { OAuthScope } from './oauth-scopes';

export type { OAuthScope };

/** RFC 7591 application_type. */
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
 *. Deliberately NOT in OAUTH_CLIENTS: it has no redirect URIs and no
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

/**
 * A client the platform did not configure itself: registered dynamically or
 * identified by a metadata document. Its tokens are limited to the MCP resource.
 */
export function isDelegatedClient(client: OAuthClient): boolean {
  return client.source === 'dynamic' || client.source === 'cimd';
}

/** A URL-shaped client_id is a CIMD candidate; it is never an opaque id. */
export function isUrlClientId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

export interface RedirectTarget {
  host: string;
  /** localhost / 127.0.0.1 / [::1]: the code goes to an app on this device. */
  loopback: boolean;
}

/**
 * What a user can check before trusting an app, as two separate facts: where
 * the app's identity document is hosted (CIMD client_id host) and where the
 * authorization code is sent (redirect host). `redirectMismatch` is true when a
 * non-loopback redirect host is not EXACTLY the client_id host. That is a
 * visible caution, not a verdict: no registrable-domain logic, no deny list.
 */
export interface ClientAddresses {
  documentHost?: string;
  redirectTargets: RedirectTarget[];
  redirectMismatch: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(uri: string): string | undefined {
  try {
    return new URL(uri).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Computed server-side at authorize time so consent cannot be shown a host the
 * server did not derive. `redirectUri` is the one in this request when known;
 * otherwise (Connected apps) every registered URI, deduplicated, loopback
 * entries collapsed into one.
 */
export function describeClientAddresses(
  clientId: string,
  client: Pick<OAuthClient, 'redirectUris'> | null,
  redirectUri?: string,
): ClientAddresses {
  const documentHost = isUrlClientId(clientId)
    ? hostnameOf(clientId)
    : undefined;
  const uris = redirectUri ? [redirectUri] : (client?.redirectUris ?? []);
  const redirectTargets: RedirectTarget[] = [];
  for (const uri of uris) {
    const host = hostnameOf(uri);
    if (!host) continue;
    const loopback = LOOPBACK_HOSTS.has(host);
    if (
      redirectTargets.some((t) => (loopback ? t.loopback : t.host === host))
    ) {
      continue;
    }
    redirectTargets.push({ host, loopback });
  }
  const redirectMismatch =
    documentHost !== undefined &&
    redirectTargets.some((t) => !t.loopback && t.host !== documentHost);
  return { documentHost, redirectTargets, redirectMismatch };
}
