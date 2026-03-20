import { describe, it, expect, vi } from 'vitest';
import {
  HttpException,
  HttpStatus,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHost(jsonFn = vi.fn(), statusFn?: ReturnType<typeof vi.fn>) {
  const status = statusFn ?? vi.fn().mockReturnValue({ json: jsonFn });
  const response = { status };
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();

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
        message: ['email must be an email', 'password must be longer than 8 characters'],
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
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
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

    it('should return 500 for programmer errors (non-HttpException)', () => {
      const jsonFn = vi.fn();
      const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
      const host = makeHost(jsonFn, statusFn);

      filter.catch(new TypeError('cannot read property of undefined'), host);

      expect(statusFn).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });
});
