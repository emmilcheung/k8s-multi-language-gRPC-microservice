import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { Response } from 'express';
import { GraphQLError } from 'graphql';

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // For GraphQL (or other non-HTTP) contexts there is no Express Response —
    // calling response.status(...) would throw TypeError. Re-throw so the
    // GraphQL driver formats the error itself.
    if (host.getType<'http' | 'graphql' | 'rpc' | 'ws'>() !== 'http') {
      throw this.toGraphQLError(exception);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Pass through structured { error: { code, message } } bodies
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as Record<string, unknown>).error === 'object' &&
        (body as Record<string, unknown>).error !== null
      ) {
        return response.status(status).json(body);
      }

      // NestJS ValidationPipe errors: { message: string[], error: string, statusCode: number }
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const msg = body as { message: string | string[]; error?: string };
        const details = Array.isArray(msg.message)
          ? msg.message.map((m) => ({ issue: m }))
          : [{ issue: msg.message }];
        return response.status(status).json({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details,
          },
        });
      }

      return response.status(status).json({
        error: {
          code: 'HTTP_ERROR',
          message: typeof body === 'string' ? body : JSON.stringify(body),
        },
      });
    }

    // Programmer error — return generic 500, never leak internals
    this.logger.error({ err: exception }, '[GlobalExceptionFilter] Unhandled error');
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }

  // Extract the same { code, message } shape we'd surface over REST and
  // re-throw as a GraphQLError so Apollo formats it with a meaningful message
  // instead of falling back to the exception class name.
  private toGraphQLError(exception: unknown): GraphQLError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message = exception.message;
      let code: string | undefined;
      if (typeof body === 'object' && body !== null) {
        const rec = body as Record<string, unknown>;
        const errField = rec['error'];
        if (typeof errField === 'object' && errField !== null) {
          const err = errField as Record<string, unknown>;
          if (typeof err['message'] === 'string') message = err['message'];
          if (typeof err['code'] === 'string') code = err['code'];
        } else if ('message' in rec) {
          const raw = rec['message'];
          message = Array.isArray(raw) ? raw.join('; ') : String(raw);
        }
      } else if (typeof body === 'string') {
        message = body;
      }
      // Intentionally not setting extensions.http.status — standard GraphQL
      // returns HTTP 200 with errors in the body; the resolver-level status is
      // surfaced via extensions.statusCode for clients that want it.
      return new GraphQLError(message, { extensions: { code, statusCode: status } });
    }
    this.logger.error({ err: exception }, '[GlobalExceptionFilter] Unhandled error (non-http)');
    return new GraphQLError('An unexpected error occurred', {
      extensions: { code: 'INTERNAL_ERROR' },
    });
  }
}
