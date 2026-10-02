import { z } from 'zod';

/** Auth-service token issuer for browser tokens; Kong's credential key (D3). */
export const BROWSER_TOKEN_ISSUER = 'auth-service';

const DEV_ORIGIN = 'http://localhost:8000';

/** Only `true` / `false` are accepted; anything else is a typo that must fail loud. */
const boolString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/**
 * OAuth resource-server env (C-2, C-4, D3). Outside production these default to
 * the local Kong origin; in production they are required (see refineOAuthConfig).
 * The strings are kept raw here: `parseResources` splits the list.
 */
export const oauthEnvFields = {
  OAUTH_ISSUER: z.string().url().optional(),
  OAUTH_RESOURCES: z.string().optional(),
  OAUTH_MCP_RESOURCE: z.string().url().optional(),
  OAUTH_API_AUDIENCE: z.string().url().optional(),
  /**
   * D3 rollout switch. Off: OAuth tokens keep `iss: auth-service` so Kong's
   * existing credential still accepts them on REST. WS-K adds the second Kong
   * jwt_secret keyed on OAUTH_ISSUER and flips this in the same release.
   */
  OAUTH_ISSUER_ENABLED: boolString,
  /**
   * Client ID Metadata Documents (WS-I, D12). Off by default: turning it on makes
   * auth-service (the token signing key holder) fetch HTTPS documents from URLs
   * chosen by unauthenticated callers, which in a cluster also needs an egress
   * NetworkPolicy opening that the owner must approve (spec hard stop 10).
   */
  OAUTH_CIMD_ENABLED: boolString,
  /**
   * lowercase hex SHA-256 of the mcp-service client secret (C-5). Unset or empty
   * disables the token-exchange grant (the client cannot authenticate); a set
   * but malformed value fails startup. See refineOAuthConfig.
   */
  MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH: z.string().optional(),
};

export function parseResources(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Production URLs must be https, non-loopback and fragment-free. */
function assertProdSafeUrl(
  key: string,
  value: string,
  fail: (key: string, message: string) => void,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return; // shape errors are reported by the caller
  }
  if (url.protocol !== 'https:') {
    fail(key, `${key} must use https in production: ${value}`);
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    fail(key, `${key} must not point at localhost in production: ${value}`);
  }
  if (url.hash || value.includes('#')) {
    fail(key, `${key} must not contain a fragment: ${value}`);
  }
}

interface OAuthEnv {
  NODE_ENV?: string;
  OAUTH_ISSUER?: string;
  OAUTH_RESOURCES?: string;
  OAUTH_MCP_RESOURCE?: string;
  OAUTH_API_AUDIENCE?: string;
  MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH?: string;
}

/**
 * Fail loud at startup: every resource is an absolute URL, and both the MCP
 * audience and the default API audience are members of the allowlist (a
 * default audience a client could never request would be a silent trap).
 * Production must set all four values explicitly.
 */
export function refineOAuthConfig(
  config: OAuthEnv,
  ctx: z.RefinementCtx,
): void {
  const fail = (key: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [key], message });

  const secretHash = config.MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH;
  if (secretHash && !/^[0-9a-f]{64}$/.test(secretHash)) {
    // A typo'd or plaintext value must never be silently treated as a hash.
    fail(
      'MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH',
      'MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH must be the lowercase hex SHA-256 (64 chars) of the secret, never the plaintext secret',
    );
  }

  const prod = config.NODE_ENV === 'production';
  const keys = [
    'OAUTH_ISSUER',
    'OAUTH_RESOURCES',
    'OAUTH_MCP_RESOURCE',
    'OAUTH_API_AUDIENCE',
  ] as const;
  if (prod) {
    for (const k of keys) {
      if (!config[k]) {
        fail(
          k,
          `${k} is required in production: set the public https origin (Helm global.publicOrigin) that derives it`,
        );
      }
    }
    if (config.OAUTH_ISSUER)
      assertProdSafeUrl('OAUTH_ISSUER', config.OAUTH_ISSUER, fail);
  }

  const resources = parseResources(
    config.OAUTH_RESOURCES ?? `${DEV_ORIGIN}/mcp,${DEV_ORIGIN}/api`,
  );
  for (const r of resources) {
    if (!isAbsoluteUrl(r)) {
      fail(
        'OAUTH_RESOURCES',
        `OAUTH_RESOURCES member is not an absolute URL: ${r}`,
      );
      continue;
    }
    // RFC 8707 §2: a resource identifier must not contain a fragment.
    if (new URL(r).hash || r.includes('#')) {
      fail(
        'OAUTH_RESOURCES',
        `OAUTH_RESOURCES member must not contain a fragment: ${r}`,
      );
    }
    if (prod) assertProdSafeUrl('OAUTH_RESOURCES', r, fail);
  }
  const mcp = config.OAUTH_MCP_RESOURCE ?? `${DEV_ORIGIN}/mcp`;
  const api = config.OAUTH_API_AUDIENCE ?? `${DEV_ORIGIN}/api`;
  if (!resources.includes(mcp)) {
    fail(
      'OAUTH_MCP_RESOURCE',
      'OAUTH_MCP_RESOURCE must be a member of OAUTH_RESOURCES',
    );
  }
  if (!resources.includes(api)) {
    fail(
      'OAUTH_API_AUDIENCE',
      'OAUTH_API_AUDIENCE must be a member of OAUTH_RESOURCES',
    );
  }
}

/** Effective config with dev defaults applied. */
export interface OAuthResourceConfig {
  issuer: string;
  resources: string[];
  mcpResource: string;
  apiAudience: string;
  issuerEnabled: boolean;
  cimdEnabled: boolean;
}

type Getter = { get<T = string>(key: string): T | undefined };

export function readOAuthConfig(config: Getter): OAuthResourceConfig {
  const issuer = (config.get('OAUTH_ISSUER') ?? DEV_ORIGIN).replace(/\/+$/, '');
  return {
    issuer,
    resources: parseResources(
      config.get('OAUTH_RESOURCES') ?? `${DEV_ORIGIN}/mcp,${DEV_ORIGIN}/api`,
    ),
    mcpResource: config.get('OAUTH_MCP_RESOURCE') ?? `${DEV_ORIGIN}/mcp`,
    apiAudience: config.get('OAUTH_API_AUDIENCE') ?? `${DEV_ORIGIN}/api`,
    issuerEnabled: String(config.get('OAUTH_ISSUER_ENABLED')) === 'true',
    cimdEnabled: String(config.get('OAUTH_CIMD_ENABLED')) === 'true',
  };
}

/** The mcp-service secret hash, or undefined when token exchange is disabled. */
export function readTokenExchangeSecretHash(
  config: Getter,
): string | undefined {
  return config.get('MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH') || undefined;
}

/** The one place the `iss` of an OAuth access token is chosen (D3, E-9). */
export function resolveOAuthTokenIssuer(cfg: OAuthResourceConfig): string {
  return cfg.issuerEnabled ? cfg.issuer : BROWSER_TOKEN_ISSUER;
}
