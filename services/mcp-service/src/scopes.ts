import type { ScopeChallengeHandler } from '@modelcontextprotocol/server';

/**
 * The scope each tool needs. The registry of
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
 * Scopes a tool needs beyond its table scope because it makes more than one
 * upstream call: pay_for_order_with_default lists saved methods (payments:read)
 * before charging (payments:create). Without it the step-up would pass and the
 * upstream read would then 403.
 */
export const EXTRA_SCOPES: Partial<Record<ToolName, readonly ToolScope[]>> = {
  pay_for_order_with_default: ['payments:read'],
};

/** Every scope the tool's upstream calls need, table scope first. */
export const scopesForTool = (tool: ToolName): ToolScope[] => [
  TOOL_SCOPES[tool],
  ...(EXTRA_SCOPES[tool] ?? []),
];

/**
 * Step-up: challenge with held ∪ required so the re-consent keeps what the
 * user already granted. The SDK's own `requireScopes` asks for the required set
 * only, which would make a client drop its existing grants on step-up.
 * Unauthenticated requests are left to the bearer gate in app.ts.
 */
export function requireScope(...required: ToolScope[]): ScopeChallengeHandler {
  return ({ authInfo }) => {
    if (authInfo === undefined) return;
    if (required.every((scope) => authInfo.scopes.includes(scope))) return;
    const [first, ...rest] = [...new Set([...authInfo.scopes, ...required])];
    return { scopes: [first, ...rest] };
  };
}
