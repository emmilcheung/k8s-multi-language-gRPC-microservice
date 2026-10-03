/**
 * Single registry of OAuth scopes . Owner: auth-service.
 * The consent UI reads it through `scopes_supported` and GET /oauth/scopes.
 * The scope -> tool map lives in mcp-service and is pinned by a contract test.
 * `venues:read` and `seating:hold` stay registered even though no tool uses them.
 */
export interface OAuthScopeInfo {
  /** Human-readable consent label. */
  label: string;
  /** True when granting the scope lets a client change orders or move money. */
  sensitive: boolean;
}

export const OAUTH_SCOPES = {
  'tickets:read': { label: 'Browse events and tickets', sensitive: false },
  'orders:read': { label: 'View your orders', sensitive: false },
  'orders:create': { label: 'Place orders on your behalf', sensitive: true },
  'orders:cancel': { label: 'Cancel your orders', sensitive: true },
  'payments:read': { label: 'View your payments', sensitive: false },
  'payments:create': {
    label: 'Pay for orders on your behalf',
    sensitive: true,
  },
  'venues:read': { label: 'Browse venues', sensitive: false },
  'seating:read': { label: 'View seat availability', sensitive: false },
  'seating:hold': { label: 'Hold seats for you', sensitive: false },
} as const satisfies Record<string, OAuthScopeInfo>;

export type OAuthScope = keyof typeof OAUTH_SCOPES;

export const OAUTH_SCOPE_NAMES = Object.keys(OAUTH_SCOPES) as OAuthScope[];
