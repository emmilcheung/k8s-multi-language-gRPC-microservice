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
  describe('production URL safety', () => {
    const prodSchema = z
      .object({ NODE_ENV: z.string(), ...oauthEnvFields })
      .superRefine(refineOAuthConfig);
    const origin = 'https://ticketing.example.com';
    const prod = {
      NODE_ENV: 'production',
      OAUTH_ISSUER: origin,
      OAUTH_RESOURCES: `${origin}/mcp,${origin}/api`,
      OAUTH_MCP_RESOURCE: `${origin}/mcp`,
      OAUTH_API_AUDIENCE: `${origin}/api`,
    };
    const messages = (input: object) => {
      const r = prodSchema.safeParse(input);
      return r.success ? null : JSON.stringify(r.error.issues);
    };

    it('accepts a public https origin', () => {
      expect(prodSchema.safeParse(prod).success).toBe(true);
    });

    it('a missing origin error names global.publicOrigin so the operator knows what to set', () => {
      const out = messages({ NODE_ENV: 'production' });
      expect(out).toContain('OAUTH_ISSUER is required in production');
      expect(out).toContain('global.publicOrigin');
    });

    it.each([
      [
        'http issuer',
        { OAUTH_ISSUER: 'http://ticketing.example.com' },
        'https',
      ],
      ['localhost issuer', { OAUTH_ISSUER: 'https://localhost' }, 'localhost'],
      ['127.0.0.1 issuer', { OAUTH_ISSUER: 'https://127.0.0.1' }, 'localhost'],
      ['[::1] issuer', { OAUTH_ISSUER: 'https://[::1]' }, 'localhost'],
      ['issuer fragment', { OAUTH_ISSUER: `${origin}#x` }, 'fragment'],
    ])(
      'rejects %s (copy-pasted dev values must not boot in prod)',
      (_n, over, msg) => {
        expect(messages({ ...prod, ...over })).toContain(msg);
      },
    );

    it.each([
      ['http resource', 'http://ticketing.example.com/mcp', 'https'],
      ['localhost resource', 'https://localhost/mcp', 'localhost'],
      ['loopback resource', 'https://127.0.0.1/mcp', 'localhost'],
      ['ipv6 loopback resource', 'https://[::1]/mcp', 'localhost'],
    ])('rejects a %s in OAUTH_RESOURCES', (_n, bad, msg) => {
      const out = messages({
        ...prod,
        OAUTH_RESOURCES: `${bad},${origin}/api`,
        OAUTH_MCP_RESOURCE: bad,
      });
      expect(out).toContain(msg);
    });

    it('the dev localhost values still pass outside production', () => {
      expect(
        prodSchema.safeParse({ NODE_ENV: 'development', ...valid }).success,
      ).toBe(true);
    });
  });

  it.each(['development', 'production'])(
    'rejects a resource fragment in %s (RFC 8707 forbids it)',
    (env) => {
      const base =
        env === 'production'
          ? {
              OAUTH_ISSUER: 'https://t.example.com',
              OAUTH_RESOURCES:
                'https://t.example.com/mcp#f,https://t.example.com/api',
              OAUTH_MCP_RESOURCE: 'https://t.example.com/mcp#f',
              OAUTH_API_AUDIENCE: 'https://t.example.com/api',
            }
          : {
              ...valid,
              OAUTH_RESOURCES: `${valid.OAUTH_MCP_RESOURCE}#f,${valid.OAUTH_API_AUDIENCE}`,
              OAUTH_MCP_RESOURCE: `${valid.OAUTH_MCP_RESOURCE}#f`,
            };
      const r = z
        .object({ NODE_ENV: z.string(), ...oauthEnvFields })
        .superRefine(refineOAuthConfig)
        .safeParse({ NODE_ENV: env, ...base });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('fragment');
    },
  );
});

describe('MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH (C-5)', () => {
  const KEY = 'MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH';

  it.each([undefined, ''])(
    'boots with the hash %j: the grant is disabled, not the service (compose passes an empty string when unset)',
    (v) => {
      const r = envSchema.safeParse({
        ...appBase,
        ...(v === undefined ? {} : { [KEY]: v }),
      });
      expect(r.success).toBe(true);
    },
  );

  it('accepts an argon2id hash', () => {
    const r = envSchema.safeParse({
      ...appBase,
      [KEY]: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
    });
    expect(r.success).toBe(true);
  });

  it('fails startup on a value that is not an argon2id hash, without echoing it (a pasted plaintext secret must not reach logs)', () => {
    const pasted = 'plaintext-secret-pasted-by-mistake';
    const r = envSchema.safeParse({ ...appBase, [KEY]: pasted });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(KEY);
    expect(JSON.stringify(r.error?.issues)).not.toContain(pasted);
  });
});
