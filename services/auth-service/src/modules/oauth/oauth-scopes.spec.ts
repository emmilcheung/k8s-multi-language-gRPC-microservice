import { describe, it, expect } from 'vitest';
import { OAUTH_SCOPES, OAUTH_SCOPE_NAMES } from './oauth-scopes';

describe('OAuth scope registry (C-7)', () => {
  it('lists the nine C-4 scopes in order; the mcp-service contract test pins the same list', () => {
    expect(OAUTH_SCOPE_NAMES).toEqual([
      'tickets:read',
      'orders:read',
      'orders:create',
      'orders:cancel',
      'payments:read',
      'payments:create',
      'venues:read',
      'seating:read',
      'seating:hold',
    ]);
  });

  it('gives every scope a consent label and marks money and order mutation as sensitive', () => {
    for (const name of OAUTH_SCOPE_NAMES) {
      expect(OAUTH_SCOPES[name].label.length).toBeGreaterThan(0);
    }
    for (const s of [
      'orders:create',
      'orders:cancel',
      'payments:create',
    ] as const) {
      expect(OAUTH_SCOPES[s].sensitive).toBe(true);
    }
    expect(OAUTH_SCOPES['tickets:read'].sensitive).toBe(false);
  });
});
