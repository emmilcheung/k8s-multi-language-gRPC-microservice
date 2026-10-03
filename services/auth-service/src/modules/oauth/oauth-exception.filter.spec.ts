import { OAuthUnavailableFilter } from './oauth-unavailable';
import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { IsString } from 'class-validator';
import { Logger } from 'nestjs-pino';
import {
  OAuthExceptionFilter,
  OAuthRegistrationExceptionFilter,
} from './oauth-exception.filter';
import { OAuthController } from './oauth.controller';

// OAuth clients (the MCP SDK among them) parse RFC 6749 §5.2 bodies. A
// wrapped {error:{code}} body hides `invalid_grant`, so a client cannot tell
// a dead refresh token from a transient failure and never re-authenticates.

function makeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json, setHeader };
}

const logger = { error: vi.fn() } as unknown as Logger;

describe('OAuthExceptionFilter', () => {
  const filter = new OAuthExceptionFilter(logger);

  it('passes an RFC error through as 400 with no-store headers', () => {
    const { host, status, json, setHeader } = makeHost();
    filter.catch(
      new UnauthorizedException({
        error: 'invalid_grant',
        error_description: 'Refresh token is invalid or expired',
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'invalid_grant',
      error_description: 'Refresh token is invalid or expired',
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('keeps a Basic-auth invalid_client as 401 with the Basic challenge (RFC 6749 §5.2)', () => {
    const { host, status, json, setHeader } = makeHost();
    filter.catch(
      new UnauthorizedException({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Basic realm="oauth"',
    );
    expect(json).toHaveBeenCalledWith({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
  });

  it('turns a real ValidationPipe rejection (e.g. an unknown `resource` field) into invalid_request', async () => {
    class Body {
      @IsString() grant_type!: string;
    }
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const err = await pipe
      .transform(
        { grant_type: 'refresh_token', resource: 'http://x/mcp' },
        { type: 'body', metatype: Body },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);

    const { host, status, json } = makeHost();
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'invalid_request',
      error_description: 'property resource should not exist',
    });
  });

  it('answers 500 server_error for non-HTTP errors and logs them without echoing internals', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('redis down at 10.0.0.5'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'server_error' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('OAuthRegistrationExceptionFilter', () => {
  it('reports validation failures as invalid_client_metadata (RFC 7591 §3.2.2)', () => {
    const { host, json } = makeHost();
    new OAuthRegistrationExceptionFilter(logger).catch(
      new BadRequestException({
        message: ['redirect_uris must be an array'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      host,
    );
    expect(json).toHaveBeenCalledWith({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must be an array',
    });
  });
});

describe('OAuthController filter wiring (RFC shape on three endpoints only)', () => {
  const filtersOf = (method: keyof OAuthController): unknown =>
    Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      OAuthController.prototype[method],
    );

  it('uses the RFC filters on token, revoke and register', () => {
    expect(filtersOf('token')).toEqual([OAuthExceptionFilter]);
    expect(filtersOf('revoke')).toEqual([OAuthExceptionFilter]);
    expect(filtersOf('register')).toEqual([OAuthRegistrationExceptionFilter]);
  });

  it('authorize keeps the docs/03 shape for everything except the retryable 503, which has its own narrow filter', () => {
    expect(filtersOf('authorize')).toEqual([OAuthUnavailableFilter]);
  });

  it('leaves the first-party JSON endpoints on the docs/03 shape', () => {
    for (const m of [
      'listClients',
      'revokeClient',
      'getConsent',
      'submitConsent',
    ] as const) {
      expect(filtersOf(m)).toBeUndefined();
    }
  });
});
