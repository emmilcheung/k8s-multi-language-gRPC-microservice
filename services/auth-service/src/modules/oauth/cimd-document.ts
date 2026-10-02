import { clientNameProblem } from './oauth-client-name.util';
import { CimdFetchError } from './cimd-fetcher';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import type { OAuthClient } from './oauth-clients.config';
import { redirectUriProblem } from './oauth-redirect.util';

/** A CIMD document may list a handful of redirect URIs, not an unbounded list. */
const MAX_REDIRECT_URIS = 10;
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const SUPPORTED_RESPONSE_TYPES = ['code'];
// eslint-disable-next-line no-control-regex

const invalid = (why: string) => new CimdFetchError('invalid_document', why);

function stringArray(value: unknown, member: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw invalid(`${member} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Turns a fetched metadata document into a client record. `clientIdUrl` is the
 * URL the caller asked for; the document must name exactly that URL. Nothing
 * from the document is trusted beyond what is checked here: it is attacker
 * controlled, and extra members are ignored.
 */
export function validateClientMetadataDocument(
  clientIdUrl: string,
  body: string,
): OAuthClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CimdFetchError('invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('document must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;

  // Byte-for-byte: otherwise one host could publish a document claiming to be
  // another application's identity.
  if (doc.client_id !== clientIdUrl) throw invalid('client_id mismatch');

  const redirectUris = stringArray(doc.redirect_uris, 'redirect_uris');
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw invalid('redirect_uris must hold 1 to 10 entries');
  }
  for (const uri of redirectUris) {
    if (redirectUriProblem(uri)) throw invalid('redirect_uri not allowed');
  }

  // CIMD clients are public. A secret cannot be shared through a public document.
  if (
    doc.token_endpoint_auth_method !== undefined &&
    doc.token_endpoint_auth_method !== 'none'
  ) {
    throw invalid('token_endpoint_auth_method must be none');
  }
  if (doc.client_secret !== undefined)
    throw invalid('client_secret not allowed');

  const grantTypes =
    doc.grant_types === undefined
      ? ['authorization_code']
      : stringArray(doc.grant_types, 'grant_types');
  if (grantTypes.some((g) => !SUPPORTED_GRANT_TYPES.includes(g))) {
    throw invalid('unsupported grant_types');
  }
  if (
    doc.response_types !== undefined &&
    stringArray(doc.response_types, 'response_types').some(
      (r) => !SUPPORTED_RESPONSE_TYPES.includes(r),
    )
  ) {
    throw invalid('unsupported response_types');
  }

  let clientName = new URL(clientIdUrl).hostname;
  if (doc.client_name !== undefined) {
    if (clientNameProblem(doc.client_name) !== null) {
      throw invalid('client_name not allowed');
    }
    clientName = (doc.client_name as string).trim() || clientName;
  }

  if (doc.scope !== undefined && typeof doc.scope !== 'string') {
    throw invalid('scope must be a string');
  }
  const requested =
    doc.scope === undefined
      ? [...OAUTH_SCOPE_NAMES]
      : doc.scope.split(' ').filter(Boolean);
  const allowedScopes = OAUTH_SCOPE_NAMES.filter((s) => requested.includes(s));

  if (
    doc.application_type !== undefined &&
    doc.application_type !== 'native' &&
    doc.application_type !== 'web'
  ) {
    throw invalid('application_type must be native or web');
  }

  return {
    clientId: clientIdUrl,
    clientName,
    redirectUris,
    grantTypes,
    pkceRequired: true,
    allowedScopes,
    accessTokenLifetimeSeconds: 900,
    refreshTokenLifetimeSeconds: 86400,
    isFirstParty: false,
    source: 'cimd',
    applicationType: doc.application_type ?? 'web',
  };
}
