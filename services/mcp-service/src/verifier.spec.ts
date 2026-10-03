import { OAuthError } from '@modelcontextprotocol/server';
import type { JWTVerifyGetKey } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintToken, stubJwks, testConfig } from './testkit.ts';
import { createVerifier } from './verifier.ts';

const verifier = (jwks: JWTVerifyGetKey = stubJwks) =>
  createVerifier({
    issuer: testConfig.OAUTH_ISSUER,
    resource: testConfig.MCP_RESOURCE,
    jwks,
  });

const withCode = (code: string): Error =>
  Object.assign(new Error('boom'), { code });

describe('verifier hardening (Wave 2 review minors)', () => {
  it('J-7: a token that expired a few seconds ago is still accepted, so small clock skew between pods does not log users out', async () => {
    const token = await mintToken({ expiresIn: '-5s' });
    await expect(verifier().verifyAccessToken(token)).resolves.toMatchObject({
      clientId: 'test-client',
    });
  });

  it('J-7: tolerance is small: a token expired a minute ago is rejected', async () => {
    const token = await mintToken({ expiresIn: '-1m' });
    await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(
      OAuthError,
    );
  });

  it('a token with an empty subject is rejected, so idempotency can never be keyed by client instead of by user', async () => {
    const token = await mintToken({ sub: '' });
    await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(
      OAuthError,
    );
  });

  it('J-7: a jose defect recognised only by err.code (e.g. a second jose copy breaks instanceof) is still a 401-class token error', async () => {
    const jwks: JWTVerifyGetKey = () =>
      Promise.reject(withCode('ERR_JWKS_NO_MATCHING_KEY'));
    await expect(
      verifier(jwks).verifyAccessToken(await mintToken()),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('J-7: a JWKS infrastructure code (timeout) is NOT a token defect: it must surface as a server error', async () => {
    const jwks: JWTVerifyGetKey = () =>
      Promise.reject(withCode('ERR_JWKS_TIMEOUT'));
    const err = await verifier(jwks)
      .verifyAccessToken(await mintToken())
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OAuthError);
    expect((err as { code?: string }).code).toBe('ERR_JWKS_TIMEOUT');
  });
});
