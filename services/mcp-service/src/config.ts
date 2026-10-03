import { z } from 'zod';

const url = z.url();

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().min(1).default('info'),
  // Public resource identifier of this server; the required `aud` of every token.
  // The token-exchange audience is derived from it as `new URL(v).origin + '/api'`
  // and must equal auth-service's OAUTH_API_AUDIENCE (helm: publicOrigin without a
  // trailing slash + '/api'). They differ if this value has an explicit default
  // port (`:443`, which URL.origin drops), an upper-case host (lower-cased) or a
  // path prefix other than the MCP route (dropped). The mismatch cannot be
  // detected at startup; auth-service would answer `invalid_target`, which the
  // tools report as an operator error. Pinned in upstream-contract.spec.ts.
  MCP_RESOURCE: url,
  // Audience of the token minted by the exchange; must equal auth-service's
  // OAUTH_API_AUDIENCE. Optional: unset, it is derived from MCP_RESOURCE as
  // described above. Helm sets it from the same publicOrigin as auth-service, so
  // the two cannot drift and the derivation quirks above stop mattering.
  API_AUDIENCE: url.optional(),
  // Authorization Server issuer; the required `iss` of every token.
  OAUTH_ISSUER: url,
  // In-cluster JWKS endpoint used to verify signatures.
  AUTH_JWKS_URL: url,
  KONG_INTERNAL_URL: url,
  TOKEN_EXCHANGE_URL: url,
  TOKEN_EXCHANGE_CLIENT_ID: z.string().min(1).default('mcp-service'),
  TOKEN_EXCHANGE_CLIENT_SECRET: z.string().min(1),
  PUBLIC_WEB_URL: url,
});

export type Config = z.infer<typeof schema>;

/**
 * Validates the environment and throws one Error naming every invalid
 * variable. Only variable names and rule messages are reported, never values,
 * so a malformed secret cannot leak through the startup failure.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
}
