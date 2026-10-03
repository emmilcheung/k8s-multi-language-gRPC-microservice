import { describe, it, expect } from 'vitest';
import { OAuthMetadataController } from './oauth-metadata.controller';

function makeController(env: Record<string, unknown> = {}) {
  const config = { get: (k: string) => env[k] };
  return new OAuthMetadataController(config as never);
}

// Authorization-server metadata, verbatim from the spec; client_id_metadata_document_supported follows
// OAUTH_CIMD_ENABLED (off by default). Clients validate this document, so drift breaks discovery.
const METADATA = {
  issuer: 'http://localhost:8000',
  authorization_endpoint: 'http://localhost:8000/oauth/authorize',
  token_endpoint: 'http://localhost:8000/oauth/token',
  revocation_endpoint: 'http://localhost:8000/oauth/revoke',
  registration_endpoint: 'http://localhost:8000/oauth/clients/register',
  jwks_uri: 'http://localhost:8000/.well-known/jwks.json',
  response_types_supported: ['code'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:token-exchange',
  ],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: [
    'tickets:read',
    'orders:read',
    'orders:create',
    'orders:cancel',
    'payments:read',
    'payments:create',
    'venues:read',
    'seating:read',
    'seating:hold',
  ],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
};

describe('OAuthMetadataController', () => {
  it('the metadata JSON equals the specified document exactly', () => {
    expect(makeController().metadata()).toStrictEqual(METADATA);
  });

  it('client_id_metadata_document_supported follows OAUTH_CIMD_ENABLED, so clients are never told CIMD works when the fetch is off', () => {
    expect(
      makeController({ OAUTH_CIMD_ENABLED: true }).metadata()
        .client_id_metadata_document_supported,
    ).toBe(true);
    expect(
      makeController({ OAUTH_CIMD_ENABLED: false }).metadata()
        .client_id_metadata_document_supported,
    ).toBe(false);
    expect(
      makeController({}).metadata().client_id_metadata_document_supported,
    ).toBe(false);
  });

  it('every endpoint is derived from OAUTH_ISSUER, ignoring a trailing slash', () => {
    const m = makeController({
      OAUTH_ISSUER: 'https://auth.example.com/',
    }).metadata();
    expect(m.issuer).toBe('https://auth.example.com');
    expect(m.token_endpoint).toBe('https://auth.example.com/oauth/token');
    expect(m.jwks_uri).toBe('https://auth.example.com/.well-known/jwks.json');
  });

  it('the metadata issuer does not change with OAUTH_ISSUER_ENABLED (clients validate it against the discovery origin, not token iss)', () => {
    expect(
      makeController({ OAUTH_ISSUER_ENABLED: true }).metadata().issuer,
    ).toBe(makeController({ OAUTH_ISSUER_ENABLED: false }).metadata().issuer);
  });

  it('GET /oauth/scopes serves the registry for the consent page', () => {
    const scopes = makeController().scopes();
    expect(scopes).toContainEqual({
      scope: 'payments:create',
      label: expect.any(String),
      sensitive: true,
    });
    expect(scopes.map((s) => s.scope)).toEqual(METADATA.scopes_supported);
  });
});
