import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const valid = {
  MCP_RESOURCE: 'http://localhost:8000/mcp',
  OAUTH_ISSUER: 'http://localhost:8000',
  AUTH_JWKS_URL: 'http://auth-service:3000/.well-known/jwks.json',
  KONG_INTERNAL_URL: 'http://kong:8000',
  TOKEN_EXCHANGE_URL: 'http://auth-service:3000/oauth/token',
  TOKEN_EXCHANGE_CLIENT_SECRET: 'test-only-not-a-real-secret',
  PUBLIC_WEB_URL: 'http://localhost:3000',
};

const withoutResource = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(valid).filter(([k]) => k !== 'MCP_RESOURCE'),
  );

describe('config', () => {
  it('G-5: loadConfig names every missing required variable, never echoing values', () => {
    expect(() => loadConfig(withoutResource())).toThrow(/MCP_RESOURCE/);
    expect(() => loadConfig({})).toThrow(/OAUTH_ISSUER/);
  });

  it('defaults the exchange client id to mcp-service (C-5 client)', () => {
    expect(loadConfig(valid).TOKEN_EXCHANGE_CLIENT_ID).toBe('mcp-service');
  });

  it('API_AUDIENCE is optional but must be a URL when set', () => {
    expect(loadConfig(valid).API_AUDIENCE).toBeUndefined();
    expect(
      loadConfig({ ...valid, API_AUDIENCE: 'http://localhost:8000/api' })
        .API_AUDIENCE,
    ).toBe('http://localhost:8000/api');
    expect(() => loadConfig({ ...valid, API_AUDIENCE: 'nope' })).toThrow(
      /API_AUDIENCE/,
    );
  });

  it('rejects a non-URL issuer so a typo cannot silently disable the iss check', () => {
    expect(() => loadConfig({ ...valid, OAUTH_ISSUER: 'not a url' })).toThrow(
      /OAUTH_ISSUER/,
    );
  });

  it('G-5: the process exits non-zero at boot when MCP_RESOURCE is missing', () => {
    const res = spawnSync(process.execPath, ['src/main.ts'], {
      env: { ...withoutResource(), PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBeNull();
    expect(res.stderr).toContain('MCP_RESOURCE');
    expect(res.stderr).not.toContain('test-only-not-a-real-secret');
  });
});
