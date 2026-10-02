import { createHash } from 'node:crypto';

/** Refresh this long before expiry so a token never dies in flight (C-5). */
const SAFETY_WINDOW_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;

export class ExchangeError extends Error {
  /** HTTP status of the failed exchange; `undefined` for a network failure. */
  readonly status: number | undefined;
  /** RFC 6749 `error` code of a rejection (e.g. `invalid_grant`); never free text. */
  readonly oauthError: string | undefined;
  constructor(status?: number, oauthError?: string) {
    super(
      status === undefined
        ? 'token exchange unreachable'
        : `token exchange rejected (${status})`,
    );
    this.status = status;
    this.oauthError = oauthError;
  }
}

interface ExchangeOptions {
  url: string;
  clientId: string;
  clientSecret: string;
  /** API audience (`OAUTH_API_AUDIENCE`) the exchanged token is minted for. */
  resource: string;
  fetch?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  /** Per-request timeout; the exchange sits on every tool call's path. */
  timeoutMs?: number;
}

export type TokenExchange = (
  subjectToken: string,
  /** Subject token `exp` in epoch seconds; bounds the cache lifetime. */
  subjectExpiresAt: number | undefined,
  scope: string,
) => Promise<string>;

/**
 * RFC 8693 client for C-5. The MCP-audience token is swapped for a short-lived
 * API-audience token scoped to the one scope a tool needs; the MCP token itself
 * is never forwarded upstream. Results are cached in-process in a bounded LRU
 * keyed by sha256(subject token) + scope, valid until
 * min(exchanged exp, subject exp) - 30 s.
 */
export function createTokenExchange(opts: ExchangeOptions): TokenExchange {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // RFC 6749 2.3.1: id and secret are form-urlencoded, each on its own, before
  // Basic encoding; auth-service decodes them, so a secret holding `+` or `:` survives.
  const basic = Buffer.from(
    `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`,
  ).toString('base64');
  // Map iteration order is insertion order: re-inserting on hit makes it LRU.
  const cache = new Map<string, { token: string; validUntil: number }>();

  return async (subjectToken, subjectExpiresAt, scope) => {
    const key = `${createHash('sha256').update(subjectToken).digest('hex')} ${scope}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      if (hit.validUntil > now()) {
        cache.set(key, hit);
        return hit.token;
      }
    }

    let res: Response;
    try {
      res = await doFetch(opts.url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: subjectToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          resource: opts.resource,
          scope,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch {
      throw new ExchangeError();
    }
    // Only the RFC 6749 `error` code is taken from a failure body, and only if
    // it has the code's shape: the rest is upstream text and is never kept.
    if (!res.ok) {
      const failure = (await res.json().catch(() => undefined)) as
        { error?: unknown } | undefined;
      const code =
        typeof failure?.error === 'string' &&
        /^[a-z_]{1,40}$/.test(failure.error)
          ? failure.error
          : undefined;
      throw new ExchangeError(res.status, code);
    }
    const body = (await res.json().catch(() => undefined)) as
      { access_token?: unknown; expires_in?: unknown } | undefined;
    if (
      typeof body?.access_token !== 'string' ||
      typeof body.expires_in !== 'number'
    ) {
      throw new ExchangeError(res.status);
    }

    let expiresAt = now() + body.expires_in * 1000;
    if (subjectExpiresAt !== undefined) {
      expiresAt = Math.min(expiresAt, subjectExpiresAt * 1000);
    }
    cache.set(key, {
      token: body.access_token,
      validUntil: expiresAt - SAFETY_WINDOW_MS,
    });
    if (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value as string);
    }
    return body.access_token;
  };
}
