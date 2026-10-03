import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOAuthConfig } from './oauth-config';
import { OAUTH_SCOPES, OAUTH_SCOPE_NAMES } from './oauth-scopes';

/**
 * RFC 8414 Authorization Server Metadata and the scope registry for the
 * consent page. These are public GETs and not RFC 6749 §5.2 endpoints, so
 * OAuthExceptionFilter (token/revoke/register only) is deliberately not
 * applied: there is no request body to reject and no OAuth error to report.
 */
@Controller()
export class OAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  @Get('.well-known/oauth-authorization-server')
  @Header('Cache-Control', 'public, max-age=300')
  metadata() {
    // The issuer is published as configured whatever OAUTH_ISSUER_ENABLED says:
    // that flag only picks the JWT `iss` claim, while clients check this
    // value against the origin they discovered it from.
    const { issuer, cimdEnabled } = readOAuthConfig(this.config);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      registration_endpoint: `${issuer}/oauth/clients/register`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...OAUTH_SCOPE_NAMES],
      authorization_response_iss_parameter_supported: true,
      // True only when OAUTH_CIMD_ENABLED: advertising CIMD while the fetch is off
      // would send clients down a path that always fails.
      client_id_metadata_document_supported: cimdEnabled,
    };
  }

  @Get('oauth/scopes')
  scopes() {
    return OAUTH_SCOPE_NAMES.map((scope) => ({
      scope,
      label: OAUTH_SCOPES[scope].label,
      sensitive: OAUTH_SCOPES[scope].sensitive,
    }));
  }
}
