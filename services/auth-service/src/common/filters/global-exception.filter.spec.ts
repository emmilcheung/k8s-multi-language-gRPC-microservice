import { describe, it, expect, vi } from 'vitest';
import {
  HttpException,
  HttpStatus,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { GlobalExceptionFilter } from './global-exception.filter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHost(jsonFn = vi.fn(), statusFn?: ReturnType<typeof vi.fn>) {
  const status = statusFn ?? vi.fn().mockReturnValue({ json: jsonFn });
  const response = { status };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function makeGraphqlHost() {
  return {
    getType: () => 'graphql',
    switchToHttp: () => ({
      getResponse: () => ({}), // no .status() — would TypeError if reached
    }),
  } as unknown as ArgumentsHost;
}

function makeFilter() {
  // Minimal mock logger that satisfies the Logger interface used by the filter
  const mockLogger = { error: vi.fn() } as unknown as Logger;
  return new GlobalExceptionFilter(mockLogger);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GlobalExceptionFilter', () => {
  const filter = makeFilter();

  describe('catch', () => {
    it('should pass through a structured { error } body from HttpException unchanged', () => {
      const jsonFn = vi.fn();
      const host = makeHost(jsonFn);
      const exception = new ConflictException({
        error: { code: 'EMAIL_IN_USE', message: 'Already exists' },
      });

      filter.catch(exception, host);

      expect(jsonFn).toHaveBeenCalledWith({
        error: { code: 'EMAIL_IN_USE', message: 'Already exists' },
      });
    });

    it('should format ValidationPipe array errors into VALIDATION_FAILED shape', () => {
      const jsonFn = vi.fn();
      const host = makeHost(jsonFn);
      const exception = new BadRequestException({
        message: [
          'email must be an email',
          'password must be longer than 8 characters',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });

      filter.catch(exception, host);

      expect(jsonFn).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: [
            { issue: 'email must be an email' },
            { issue: 'password must be longer than 8 characters' },
          ],
        },
      });
    });

    it('should return 500 INTERNAL_ERROR for non-HttpException errors', () => {
      const jsonFn = vi.fn();
      const host = makeHost(jsonFn);

      filter.catch(new Error('some unexpected crash'), host);

      expect(jsonFn).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      });
    });

    it('should use the correct HTTP status code from HttpException', () => {
      const jsonFn = vi.fn();
      const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
      const host = makeHost(jsonFn, statusFn);
      const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(exception, host);

      expect(statusFn).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    });

    it('should map HttpException to GraphQLError with structured message for graphql context', () => {
      const host = makeGraphqlHost();
      const exception = new ConflictException({
        error: { code: 'EMAIL_IN_USE', message: 'Already exists' },
      });

      let thrown: unknown;
      try {
        filter.catch(exception, host);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).toBe('Already exists');
      expect(
        (thrown as { extensions: Record<string, unknown> }).extensions.code,
      ).toBe('EMAIL_IN_USE');
    });

    it('should map non-HttpException to a generic GraphQLError without leaking internals', () => {
      const host = makeGraphqlHost();

      let thrown: unknown;
      try {
        filter.catch(new Error('internal boom: db conn refused'), host);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).toBe('An unexpected error occurred');
      expect(
        (thrown as { extensions: Record<string, unknown> }).extensions.code,
      ).toBe('INTERNAL_ERROR');
    });

    it('should return 500 for programmer errors (non-HttpException)', () => {
      const jsonFn = vi.fn();
      const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
      const host = makeHost(jsonFn, statusFn);

      filter.catch(new TypeError('cannot read property of undefined'), host);

      expect(statusFn).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });
});
