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
 * Verifies MCP access tokens per contract C-1: RS256 only, exact `iss`, exact
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
        }));
      } catch (err) {
        // Only token defects are the client's fault. A JWKS outage (timeout,
        // network) must surface as a server error, not tell clients their
        // valid token is bad and trigger pointless re-authorization.
        if (
          err instanceof errors.JOSEError &&
          !(err instanceof errors.JWKSTimeout)
        ) {
          throw invalid(err.message);
        }
        throw err;
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
