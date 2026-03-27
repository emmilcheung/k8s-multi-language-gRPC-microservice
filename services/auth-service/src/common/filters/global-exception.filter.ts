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

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // If the service already threw a structured { error: { code, message } } body, pass it through
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as Record<string, unknown>).error === 'object' &&
        (body as Record<string, unknown>).error !== null
      ) {
        return response.status(status).json(body);
      }

      // NestJS ValidationPipe errors come as { message: string[], error: string, statusCode: number }
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
    this.logger.error(
      { err: exception },
      '[GlobalExceptionFilter] Unhandled error',
    );
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  }
}
