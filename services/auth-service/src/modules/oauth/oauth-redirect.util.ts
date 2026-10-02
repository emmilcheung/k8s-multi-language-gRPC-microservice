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
