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
 * C-8 tool side: sha256(sub + tool + canonical args) as base64url (43 chars, so
 * inside the order-service `^[A-Za-z0-9_-]{8,128}$` rule). Deterministic, so an
 * agent retry of the same call replays the first order instead of making a new one.
 */
export function deriveIdempotencyKey(
  sub: string,
  tool: string,
  args: unknown,
): string {
  return createHash('sha256')
    .update(`${sub}\n${tool}\n${canonicalJson(args)}`)
    .digest('base64url')
    .slice(0, 43);
}
