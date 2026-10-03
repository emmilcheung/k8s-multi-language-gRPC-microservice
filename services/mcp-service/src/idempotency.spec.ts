import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_WINDOW_MS, deriveIdempotencyKey } from './idempotency.ts';

const args = { ticketId: 't-1', quantity: 2 };
// Start of an arbitrary window, so offsets below stay inside or leave it exactly.
const T0 = 1_000 * IDEMPOTENCY_WINDOW_MS;

describe('deriveIdempotencyKey (F-01)', () => {
  it('is stable inside one window, so an agent retry replays the first order', () => {
    const first = deriveIdempotencyKey('u', 'create_order', args, T0);
    const retry = deriveIdempotencyKey(
      'u',
      'create_order',
      { quantity: 2, ticketId: 't-1' },
      T0 + IDEMPOTENCY_WINDOW_MS - 1,
    );
    expect(retry).toBe(first);
  });

  it('changes in the next window, so identical args after expiry create a new order instead of replaying a dead one', () => {
    const before = deriveIdempotencyKey('u', 'create_order', args, T0);
    const after = deriveIdempotencyKey(
      'u',
      'create_order',
      args,
      T0 + IDEMPOTENCY_WINDOW_MS,
    );
    expect(after).not.toBe(before);
  });

  it('stays inside the order-service key rule', () => {
    expect(deriveIdempotencyKey('u', 'create_order', args, T0)).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
  });

  it('never merges users, tools or arguments', () => {
    const base = deriveIdempotencyKey('u', 'create_order', args, T0);
    expect(deriveIdempotencyKey('v', 'create_order', args, T0)).not.toBe(base);
    expect(deriveIdempotencyKey('u', 'create_seated_order', args, T0)).not.toBe(
      base,
    );
    expect(
      deriveIdempotencyKey('u', 'create_order', { ...args, quantity: 3 }, T0),
    ).not.toBe(base);
  });
});
