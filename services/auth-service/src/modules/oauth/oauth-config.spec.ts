import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { oauthEnvFields, refineOAuthConfig } from './oauth-config';
import { envSchema } from '../../config/env.schema';

const schema = z.object(oauthEnvFields).superRefine(refineOAuthConfig);

const valid = {
  OAUTH_ISSUER: 'http://localhost:8000',
  OAUTH_RESOURCES: 'http://localhost:8000/mcp,http://localhost:8000/api',
  OAUTH_MCP_RESOURCE: 'http://localhost:8000/mcp',
  OAUTH_API_AUDIENCE: 'http://localhost:8000/api',
};

const appBase = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RSA_PRIVATE_KEY: 'k',
  REDIS_URL: 'redis://localhost:6379',
};

describe('OAuth resource config (C-2)', () => {
  it('accepts the C-2 dev values', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('E-7: startup fails when OAUTH_MCP_RESOURCE is not in OAUTH_RESOURCES (a token audience outside the allowlist could never be requested)', () => {
    const r = schema.safeParse({
      ...valid,
      OAUTH_MCP_RESOURCE: 'http://localhost:8000/other',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('OAUTH_MCP_RESOURCE');
  });

  it('E-7: startup fails when OAUTH_API_AUDIENCE is not in OAUTH_RESOURCES (the default audience must be requestable)', () => {
    const r = schema.safeParse({
      ...valid,
      OAUTH_API_AUDIENCE: 'http://localhost:8000/other',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('OAUTH_API_AUDIENCE');
  });

  it('E-7: startup fails when an OAUTH_RESOURCES member is not an absolute URL', () => {
    const r = schema.safeParse({
      ...valid,
      OAUTH_RESOURCES: 'http://localhost:8000/mcp,/api',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('OAUTH_RESOURCES');
  });

  it('E-7: the real app env schema enforces it (not just the helper)', () => {
    const bad = envSchema.safeParse({
      ...appBase,
      ...valid,
      OAUTH_MCP_RESOURCE: 'http://localhost:8000/other',
    });
    expect(bad.success).toBe(false);
    expect(envSchema.safeParse({ ...appBase, ...valid }).success).toBe(true);
  });

  it('OAUTH_ISSUER_ENABLED defaults to false so REST keeps accepting OAuth tokens until WS-K', () => {
    const r = schema.parse(valid);
    expect(r.OAUTH_ISSUER_ENABLED).toBe(false);
    expect(
      schema.parse({ ...valid, OAUTH_ISSUER_ENABLED: 'true' })
        .OAUTH_ISSUER_ENABLED,
    ).toBe(true);
    expect(
      schema.safeParse({ ...valid, OAUTH_ISSUER_ENABLED: 'yes' }).success,
    ).toBe(false);
  });

  it('production has no dev defaults: missing OAuth config fails loud', () => {
    const r = envSchema.safeParse({
      ...appBase,
      NODE_ENV: 'production',
      X_USER_ID_SIGNING_KEY: 'x'.repeat(32),
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('OAUTH_ISSUER');
  });
});
