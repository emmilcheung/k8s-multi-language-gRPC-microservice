import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
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
        error: { code: 'HTTP_ERROR', message: typeof body === 'string' ? body : JSON.stringify(body) },
      });
    }

    // Programmer error — return generic 500, never leak internals
    console.error('[GlobalExceptionFilter] Unhandled error:', exception);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
}
