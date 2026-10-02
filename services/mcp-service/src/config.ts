import { z } from 'zod';

const url = z.url();

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().min(1).default('info'),
  // Public resource identifier of this server; the required `aud` of every token.
  MCP_RESOURCE: url,
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
