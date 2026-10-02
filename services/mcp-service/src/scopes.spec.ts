import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCOPES_SUPPORTED } from './app.ts';
import {
  EXTRA_SCOPES,
  TOOL_SCOPES,
  requireScope,
  scopesForTool,
} from './scopes.ts';

// FIXTURE: a copy of the scope registry in
// services/auth-service/src/modules/oauth/oauth-scopes.ts (OAUTH_SCOPES keys).
// When that registry changes, update this copy AND the C-7 map below on
// purpose: this test exists to fail on silent drift between the two services.
const AUTH_SERVICE_REGISTRY = [
  'tickets:read',
  'orders:read',
  'orders:create',
  'orders:cancel',
  'payments:read',
  'payments:create',
  'venues:read',
  'seating:read',
  'seating:hold',
];
// Registered upstream but deliberately used by no tool (C-7).
const UNUSED_SCOPES = ['venues:read', 'seating:hold'];

// C-7, in table order (registration order is deterministic).
const C7 = {
  search_events: 'tickets:read',
  get_event: 'tickets:read',
  view_seat_availability: 'seating:read',
  list_my_orders: 'orders:read',
  get_order: 'orders:read',
  create_order: 'orders:create',
  create_seated_order: 'orders:create',
  cancel_order: 'orders:cancel',
  get_payment: 'payments:read',
  list_payment_methods: 'payments:read',
  pay_for_order: 'payments:create',
  pay_for_order_with_default: 'payments:create',
};

describe('scope -> tool map (C-7)', () => {
  it('J-1: equals the C-7 table, in order, so a tool cannot silently gain or lose a scope', () => {
    expect(Object.entries(TOOL_SCOPES)).toEqual(Object.entries(C7));
  });

  it('J-1: the only tool needing more than its C-7 scope is pay_for_order_with_default (+ payments:read), per the C-7 amendment', () => {
    // Pinned so the exception cannot grow silently: a new entry here widens
    // what an agent token must hold, and that is a contract change (C-7).
    expect(EXTRA_SCOPES).toEqual({
      pay_for_order_with_default: ['payments:read'],
    });
    expect(scopesForTool('pay_for_order_with_default')).toEqual([
      'payments:create',
      'payments:read',
    ]);
  });

  it('J-1: every scope a tool needs exists in the auth-service registry (a rename there must fail here)', () => {
    for (const scope of Object.values(TOOL_SCOPES)) {
      expect(AUTH_SERVICE_REGISTRY).toContain(scope);
    }
  });

  it('J-1: the scopes advertised in PRM are exactly the registry minus the unused ones', () => {
    expect([...SCOPES_SUPPORTED].sort()).toEqual(
      AUTH_SERVICE_REGISTRY.filter((s) => !UNUSED_SCOPES.includes(s)).sort(),
    );
  });
});

describe('requireScope challenge (C-6)', () => {
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call' } as never;
  const auth = (scopes: string[]) =>
    ({ token: 't', clientId: 'c', scopes }) as never;

  it('J-2: asks for held plus required, so a step-up keeps what the user already granted', async () => {
    const challenge = await requireScope('orders:create')({
      request,
      authInfo: auth(['tickets:read']),
    });
    expect(challenge?.scopes).toEqual(['tickets:read', 'orders:create']);
  });

  it('J-2: no challenge when the scope is already held', async () => {
    expect(
      await requireScope('orders:create')({
        request,
        authInfo: auth(['orders:create']),
      }),
    ).toBeUndefined();
  });
});

// The fixture above only drifts on purpose if something compares it with the
// real registry. That file exists in a repo checkout but not in the Docker
// build context, so the guard skips there, loudly.
const REGISTRY_FILE = new URL(
  '../../auth-service/src/modules/oauth/oauth-scopes.ts',
  import.meta.url,
);
describe('auth-service registry drift guard', () => {
  it.skipIf(!existsSync(REGISTRY_FILE))(
    'J-1: the fixture equals the keys of the real OAUTH_SCOPES registry (skipped when services/auth-service is not on disk, e.g. the Docker build context)',
    () => {
      const source = readFileSync(REGISTRY_FILE, 'utf8');
      const body = /export const OAUTH_SCOPES = \{([\s\S]*?)\n\} as const/.exec(
        source,
      )?.[1];
      expect(body, 'OAUTH_SCOPES literal found').toBeDefined();
      const keys = [...body!.matchAll(/^ {2}'([a-z]+:[a-z]+)':/gm)].map(
        (m) => m[1],
      );
      expect(keys).toEqual(AUTH_SERVICE_REGISTRY);
    },
  );
});
