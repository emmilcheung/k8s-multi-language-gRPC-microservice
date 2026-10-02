import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import { ExchangeError, type TokenExchange } from './exchange.ts';
import { scopesForTool, type ToolName } from './scopes.ts';

/** Error codes a tool can return; messages are fixed text, never upstream text. */
export type FailureCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'WAITING_ROOM_ACTIVE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_EXHAUSTED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NO_DEFAULT_PAYMENT_METHOD'
  | 'UPSTREAM_ERROR';

const MESSAGES: Record<FailureCode, string> = {
  UNAUTHORIZED:
    'The platform did not accept the credentials for this call. Re-authorize and try again.',
  FORBIDDEN:
    'The platform refused this action for the granted scopes or account.',
  WAITING_ROOM_ACTIVE:
    'A virtual waiting room is active for this event. Ask the user to finish the purchase in their browser.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  INVALID_REQUEST: 'The platform rejected the request as invalid.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  IDEMPOTENCY_KEY_EXHAUSTED:
    'This idempotency key belongs to an earlier attempt whose reservation is no longer active. Retry with a new idempotencyKey.',
  IDEMPOTENCY_KEY_REUSED:
    'This idempotency key was already used with different arguments. Use a new idempotencyKey for a different request.',
  NO_DEFAULT_PAYMENT_METHOD:
    'No default payment method is set. Ask the user to set one in Settings, or use pay_for_order with a savedPaymentMethodId from list_payment_methods.',
  UPSTREAM_ERROR: 'The platform had an internal error. Try again later.',
};

export class ToolFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

export interface UpstreamRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export interface UpstreamResponse {
  data: unknown;
  /** order-service answered an already-seen Idempotency-Key (`Idempotent-Replayed: true`, C-8). */
  replayed: boolean;
}

export interface Upstream {
  request(
    auth: AuthInfo,
    tool: ToolName,
    req: UpstreamRequest,
  ): Promise<UpstreamResponse>;
}

interface UpstreamOptions {
  /** Kong, reached in-cluster. */
  baseUrl: string;
  exchange: TokenExchange;
  fetch?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'error'>;
  /** Per-request timeout for Kong calls. */
  timeoutMs?: number;
}

const IDEMPOTENCY_CODES = new Set<FailureCode>([
  'IDEMPOTENCY_KEY_EXHAUSTED',
  'IDEMPOTENCY_KEY_REUSED',
]);

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => undefined);
}

/** Maps a non-2xx upstream reply to a code. The body is inspected, never echoed. */
async function classify(res: Response): Promise<FailureCode> {
  const { status } = res;
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) {
    // Kong's queue gate answers `{"message":"waiting room: ..."}` (C-9).
    const body = (await readJson(res)) as { message?: unknown } | undefined;
    return typeof body?.message === 'string' &&
      body.message.startsWith('waiting room:')
      ? 'WAITING_ROOM_ACTIVE'
      : 'FORBIDDEN';
  }
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 422) {
    const body = (await readJson(res)) as
      { error?: { code?: unknown } } | undefined;
    const code = body?.error?.code as FailureCode;
    if (IDEMPOTENCY_CODES.has(code)) return code;
    return status === 409 ? 'CONFLICT' : 'INVALID_REQUEST';
  }
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_ERROR';
}

/**
 * Calls the API through Kong with an exchanged, API-audience token narrowed to
 * the tool's scopes (C-5). Anything that goes wrong becomes a ToolFailure with
 * fixed text: upstream bodies and tokens never reach a tool result or a log.
 */
export function createUpstream(opts: UpstreamOptions): Upstream {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');

  return {
    async request(auth, tool, req) {
      let apiToken: string;
      try {
        apiToken = await opts.exchange(
          auth.token,
          auth.expiresAt,
          scopesForTool(tool).join(' '),
        );
      } catch (err) {
        const status = err instanceof ExchangeError ? err.status : undefined;
        const oauthError =
          err instanceof ExchangeError ? err.oauthError : undefined;
        // Only `invalid_grant` says the subject token is bad (re-authorize).
        // invalid_client / unauthorized_client / invalid_target / invalid_scope
        // and 5xx or network failures are our misconfiguration or an outage:
        // looping the user through consent would not fix them (C-5).
        if (oauthError === 'invalid_grant') {
          opts.logger?.warn(
            { tool, status, oauthError },
            'token exchange refused the subject token',
          );
          throw new ToolFailure('UNAUTHORIZED');
        }
        opts.logger?.error(
          { tool, status, oauthError },
          'token exchange failed',
        );
        throw new ToolFailure('UPSTREAM_ERROR');
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${apiToken}`,
      };
      if (req.body !== undefined) headers['content-type'] = 'application/json';
      if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

      let res: Response;
      try {
        res = await doFetch(`${base}${req.path}`, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch {
        opts.logger?.warn({ tool }, 'upstream unreachable');
        throw new ToolFailure('UPSTREAM_ERROR');
      }

      if (!res.ok) {
        const code = await classify(res);
        opts.logger?.warn({ tool, status: res.status, code }, 'upstream error');
        throw new ToolFailure(code);
      }
      const replayed = res.headers.get('idempotent-replayed') === 'true';
      const text = await res.text();
      if (!text) return { data: {}, replayed };
      try {
        return { data: JSON.parse(text) as unknown, replayed };
      } catch {
        throw new ToolFailure('UPSTREAM_ERROR');
      }
    },
  };
}
