import { describe, it, expect, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import {
  OAuthTemporarilyUnavailableException,
  OAuthUnavailableFilter,
} from './oauth-unavailable';
import { OAuthExceptionFilter } from './oauth-exception.filter';

function host() {
  const json = vi.fn();
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnValue({ json }),
  };
  return {
    res,
    json,
    h: { switchToHttp: () => ({ getResponse: () => res }) } as ArgumentsHost,
  };
}

describe('503 temporarily_unavailable with Retry-After', () => {
  it('the authorize filter answers 503 with the OAuth error body and Retry-After', () => {
    const { res, json, h } = host();
    new OAuthUnavailableFilter().catch(
      new OAuthTemporarilyUnavailableException(5),
      h,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(json).toHaveBeenCalledWith({
      error: 'temporarily_unavailable',
      error_description: expect.any(String),
    });
  });

  it('the /token filter does the same instead of folding it into a 400 invalid_request', () => {
    const { res, json, h } = host();
    new OAuthExceptionFilter({ error: vi.fn() } as never).catch(
      new OAuthTemporarilyUnavailableException(60),
      h,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'temporarily_unavailable' }),
    );
  });
});
