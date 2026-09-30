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
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };

/** Stub JWKS holding only the test key; stands in for auth-service's endpoint. */
export const stubJwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

interface MintOptions {
  iss?: string;
  aud?: string;
  scope?: string;
  clientId?: string | null;
  expiresIn?: string;
  /** Sign with HS256 instead of the RSA key (algorithm-confusion attempt). */
  hs256?: boolean;
}

/** Mints a C-1 "MCP token" shape by default; override one claim per test. */
export async function mintToken(opts: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    scope: opts.scope ?? 'tickets:read',
    ...(opts.clientId === null
      ? {}
      : { client_id: opts.clientId ?? 'test-client' }),
  })
    .setSubject('user-1')
    .setIssuer(opts.iss ?? testConfig.OAUTH_ISSUER)
    .setAudience(opts.aud ?? testConfig.MCP_RESOURCE)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(opts.expiresIn ?? '5m');
  if (opts.hs256) {
    return jwt
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .sign(new TextEncoder().encode('an-hs256-secret-of-sufficient-length!!'));
  }
  return jwt
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
}
