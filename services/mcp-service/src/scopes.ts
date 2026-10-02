import type { ScopeChallengeHandler } from '@modelcontextprotocol/server';

/**
 * C-7 (concept lock CL-SCOPES): the scope each tool needs. The registry of
 * scopes lives in auth-service (oauth-scopes.ts); scopes.spec.ts pins this map
 * against a copy of it. Key order is the tool registration order.
 */
export const TOOL_SCOPES = {
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
} as const;

export type ToolName = keyof typeof TOOL_SCOPES;
export type ToolScope = (typeof TOOL_SCOPES)[ToolName];

/**
 * C-6 step-up: challenge with held ∪ required so the re-consent keeps what the
 * user already granted. The SDK's own `requireScopes` asks for the required set
 * only, which would make a client drop its existing grants on step-up.
 * Unauthenticated requests are left to the bearer gate in app.ts.
 */
export function requireScope(scope: ToolScope): ScopeChallengeHandler {
  return ({ authInfo }) => {
    if (authInfo === undefined || authInfo.scopes.includes(scope)) return;
    // Non-empty by construction: `scope` is always last.
    const [first, ...rest] = [...authInfo.scopes, scope];
    return { scopes: [first, ...rest] };
  };
}
