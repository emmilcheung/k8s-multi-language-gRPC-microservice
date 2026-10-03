import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so argument order cannot change the key. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Width of the window a derived key stays stable for. Matches the order-service
 * expiry (`order.expiration.minutes`, default 15): an order is never replayed once
 * it could have expired, and a key whose reservation was swept after a failed create
 * (IDEMPOTENCY_KEY_EXHAUSTED) is abandoned instead of poisoning the same arguments
 * forever. order-service replays a matching order of any status with no time bound,
 * so the window has to live in the key.
 */
export const IDEMPOTENCY_WINDOW_MS = 15 * 60 * 1000;

/**
 * C-8 tool side: sha256(sub + tool + canonical args + time window) as base64url
 * (43 chars, so inside the order-service `^[A-Za-z0-9_-]{8,128}$` rule).
 * Deterministic within one window, so an agent retry of the same call replays the
 * first order instead of making a new one. A retry that straddles a window boundary
 * places a second, unpaid order; it expires on its own and nothing is charged until
 * pay_for_order.
 */
export function deriveIdempotencyKey(
  sub: string,
  tool: string,
  args: unknown,
  now: number = Date.now(),
): string {
  const window = Math.floor(now / IDEMPOTENCY_WINDOW_MS);
  return createHash('sha256')
    .update(`${sub}\n${tool}\n${canonicalJson(args)}\n${window}`)
    .digest('base64url')
    .slice(0, 43);
}
