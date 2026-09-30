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

interface OAuthEnv {
  NODE_ENV?: string;
  OAUTH_ISSUER?: string;
  OAUTH_RESOURCES?: string;
  OAUTH_MCP_RESOURCE?: string;
  OAUTH_API_AUDIENCE?: string;
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

  const prod = config.NODE_ENV === 'production';
  const keys = [
    'OAUTH_ISSUER',
    'OAUTH_RESOURCES',
    'OAUTH_MCP_RESOURCE',
    'OAUTH_API_AUDIENCE',
  ] as const;
  if (prod) {
    for (const k of keys) {
      if (!config[k]) fail(k, `${k} is required in production`);
    }
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
    }
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
  };
}

/** The one place the `iss` of an OAuth access token is chosen (D3, E-9). */
export function resolveOAuthTokenIssuer(cfg: OAuthResourceConfig): string {
  return cfg.issuerEnabled ? cfg.issuer : BROWSER_TOKEN_ISSUER;
}
