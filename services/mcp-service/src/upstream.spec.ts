import { describe, expect, it } from 'vitest';
import { createUpstream, ToolFailure } from './upstream.ts';

describe('upstream client', () => {
  it('R5: a hung Kong call times out into UPSTREAM_ERROR instead of hanging the tool call', async () => {
    const upstream = createUpstream({
      baseUrl: 'http://kong:8000',
      exchange: () => Promise.resolve('api-token'),
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          );
        }),
    });
    const failure = await upstream
      .request({ token: 't', clientId: 'c', scopes: [] }, 'get_order', {
        method: 'GET',
        path: '/api/orders/x',
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ToolFailure);
    expect((failure as ToolFailure).code).toBe('UPSTREAM_ERROR');
  });
});
