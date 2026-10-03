import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

interface VerifierOptions {
  issuer: string;
  /** Required `aud`: this server's own resource identifier (RFC 8707). */
  resource: string;
  jwks: JWTVerifyGetKey;
}

const invalid = (message: string): OAuthError =>
  new OAuthError(OAuthErrorCode.InvalidToken, message);

/**
 * jose `code`s that mean the token is bad. Matched by `code` as well as by
 * class because `instanceof` fails if two copies of jose are ever loaded.
 * Not listed on purpose: ERR_JWKS_TIMEOUT, ERR_JWKS_INVALID and network errors
 * are infrastructure failures and must stay server errors.
 */
const TOKEN_DEFECT_CODES = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  // Unknown `kid`: the token names a key auth-service does not publish.
  'ERR_JWKS_NO_MATCHING_KEY',
]);

const isTokenDefect = (err: unknown): err is Error =>
  err instanceof errors.JWTClaimValidationFailed ||
  err instanceof errors.JWTExpired ||
  err instanceof errors.JWSSignatureVerificationFailed ||
  err instanceof errors.JWSInvalid ||
  err instanceof errors.JWTInvalid ||
  err instanceof errors.JOSEAlgNotAllowed ||
  err instanceof errors.JWKSNoMatchingKey ||
  (err instanceof Error &&
    TOKEN_DEFECT_CODES.has((err as { code?: string }).code ?? ''));

/**
 * Tolerated clock skew between auth-service (signer) and this pod (verifier),
 * in seconds. Ten seconds covers ordinary NTP drift across nodes while keeping
 * the extra lifetime of an expired token negligible next to its 5-15 min life.
 */
const CLOCK_TOLERANCE_SECONDS = 10;

/**
 * Verifies MCP access tokens RS256 only, exact `iss`, exact
 * `aud` = this resource, unexpired. The audience check is what stops a token
 * minted for another resource (e.g. the REST API) being replayed here.
 */
export function createVerifier(opts: VerifierOptions): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, opts.jwks, {
          algorithms: ['RS256'],
          issuer: opts.issuer,
          audience: opts.resource,
          requiredClaims: ['exp', 'sub'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        }));
      } catch (err) {
        // Only token defects are the client's fault. JWKS infrastructure
        // failures (non-200, malformed JWKS, timeout, network) must surface as
        // a server error, not tell clients their valid token is bad and
        // trigger pointless re-authorization.
        if (isTokenDefect(err)) throw invalid(err.message);
        throw err;
      }
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw invalid('missing "sub" claim');
      }
      if (typeof payload.client_id !== 'string' || !payload.client_id) {
        throw invalid('missing "client_id" claim');
      }
      return {
        token,
        clientId: payload.client_id,
        scopes:
          typeof payload.scope === 'string'
            ? payload.scope.split(' ').filter(Boolean)
            : [],
        expiresAt: payload.exp,
        resource: new URL(opts.resource),
        extra: { sub: payload.sub },
      };
    },
  };
}
