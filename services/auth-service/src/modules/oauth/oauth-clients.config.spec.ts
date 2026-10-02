import { describe, it, expect } from 'vitest';
import {
  findClient,
  validateScopes,
  OAUTH_CLIENTS,
} from './oauth-clients.config';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import type { OAuthClient } from './oauth-clients.config';

describe('findClient', () => {
  it('returns the ticketing-mcp client by id', () => {
    const client = findClient('ticketing-mcp');
    expect(client).toBeDefined();
    expect(client?.clientId).toBe('ticketing-mcp');
    expect(client?.pkceRequired).toBe(true);
  });

  it('returns undefined for an unknown clientId', () => {
    expect(findClient('not-a-client')).toBeUndefined();
  });
});

describe('validateScopes', () => {
  const fullClient = OAUTH_CLIENTS[0];

  it('returns all requested scopes when every one is allowed', () => {
    const result = validateScopes(['tickets:read', 'orders:read'], fullClient);
    expect(result).toEqual(['tickets:read', 'orders:read']);
  });

  it('filters out scopes not in the client allowlist', () => {
    const restricted: OAuthClient = {
      ...fullClient,
      allowedScopes: ['tickets:read'],
    };
    const result = validateScopes(
      ['tickets:read', 'orders:create'],
      restricted,
    );
    expect(result).toEqual(['tickets:read']);
  });

  it('returns empty array when none of the requested scopes are allowed', () => {
    const restricted: OAuthClient = {
      ...fullClient,
      allowedScopes: ['tickets:read'],
    };
    expect(
      validateScopes(['orders:create', 'payments:create'], restricted),
    ).toEqual([]);
  });

  it('returns empty array for an empty request', () => {
    expect(validateScopes([], fullClient)).toEqual([]);
  });

  it('ticketing-mcp allows every defined scope', () => {
    const allScopes = [...OAUTH_SCOPE_NAMES];
    const result = validateScopes(allScopes, fullClient);
    expect(result).toEqual(allScopes);
  });
});
