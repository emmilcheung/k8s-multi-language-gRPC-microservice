import { BadRequestException } from '@nestjs/common';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/**
 * True when `requested` may be used given the client's registered URIs.
 * Exact match always works. RFC 8252 §7.3: for a registered http loopback URI
 * (127.0.0.1, [::1], localhost) the port may differ, because native apps bind
 * an ephemeral one. Scheme, host, path and query must still match, so a
 * loopback registration never widens to another host.
 */
export function redirectUriMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) return true;
  const req = parse(requested);
  if (!req || req.protocol !== 'http:' || !LOOPBACK_HOSTS.has(req.hostname)) {
    return false;
  }
  if (req.username || req.password || req.hash) return false;
  return registered.some((r) => {
    const reg = parse(r);
    return (
      reg !== null &&
      reg.protocol === 'http:' &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

/**
 * Why `uri` may not be registered as a redirect URI, or null when it is fine.
 * The single registration-time rule shared by DCR and CIMD (F7): https, or http
 * on localhost / 127.0.0.1 only, so an authorization code never crosses the
 * network in clear. Matching at /authorize time stays in redirectUriMatches.
 */
export function redirectUriProblem(uri: string): string | null {
  const parsed = parse(uri);
  if (!parsed) return `Invalid URI: ${uri}`;
  const isLocalhost =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLocalhost)
  ) {
    return `redirect_uri must use HTTPS or be localhost: ${uri}`;
  }
  // RFC 6749 3.1.2: no fragment. Userinfo has no place in a redirect target.
  if (parsed.hash || parsed.username || parsed.password) {
    return `redirect_uri must not carry a fragment or credentials: ${uri}`;
  }
  return null;
}

/** RFC 7591 §3.2.2 error for the first redirect URI that fails the shared rule. */
export function assertValidRedirectUris(uris: readonly string[]): void {
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) {
      throw new BadRequestException({
        error: 'invalid_redirect_uri',
        error_description: problem,
      });
    }
  }
}
