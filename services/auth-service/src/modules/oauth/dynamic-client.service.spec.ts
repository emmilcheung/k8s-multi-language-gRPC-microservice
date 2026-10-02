import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { DynamicClientService } from './dynamic-client.service';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';

function make() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
  };
  return { service: new DynamicClientService(redis as never), redis };
}

const base = {
  clientName: 'App',
  redirectUris: ['https://app.example.com/cb'],
};

describe('DynamicClientService.register', () => {
  it('F7: with no scope requested, grants exactly the scope registry (no second copy of the list)', async () => {
    const { service } = make();
    const client = await service.register(base);
    expect(client.allowedScopes).toEqual([...OAUTH_SCOPE_NAMES]);
  });

  it('F7: drops scopes the registry does not know', async () => {
    const { service } = make();
    const client = await service.register({
      ...base,
      scope: 'tickets:read admin:everything',
    });
    expect(client.allowedScopes).toEqual(['tickets:read']);
  });

  it('F7: validates redirect URIs with the shared validator', async () => {
    const { service, redis } = make();
    await expect(
      service.register({
        ...base,
        redirectUris: ['http://evil.example.com/cb'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('I-8/DCR: application_type defaults to web and a native registration is stored as native', async () => {
    const { service } = make();
    expect((await service.register(base)).applicationType).toBe('web');
    const native = await service.register({
      ...base,
      applicationType: 'native',
    });
    expect(native.applicationType).toBe('native');
    const found = await service.findClient(native.clientId);
    expect(found?.applicationType).toBe('native');
  });
});
