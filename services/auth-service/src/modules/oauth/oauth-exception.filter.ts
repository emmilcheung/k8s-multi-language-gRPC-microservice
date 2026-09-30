import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import type { Response } from 'express';

/** RFC 6749 §5.2 error body. */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

/**
 * RFC 6749 §5.2 / RFC 7009 §2.2.1 errors for /oauth/token and /oauth/revoke
 * (spec D8). Every 4xx becomes 400 {error, error_description}; anything else
 * is a 500 server_error that leaks nothing. The rest of auth-service keeps the
 * docs/03 {error:{code,message}} shape via GlobalExceptionFilter.
 */
@Injectable()
@Catch()
export class OAuthExceptionFilter implements ExceptionFilter {
  protected readonly invalidRequestCode: string = 'invalid_request';

  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      return response
        .status(HttpStatus.BAD_REQUEST)
        .json(this.toOAuthError(exception.getResponse()));
    }

    this.logger.error(
      { err: exception },
      '[OAuthExceptionFilter] Unhandled error',
    );
    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'server_error' });
  }

  private toOAuthError(body: string | object): OAuthErrorBody {
    if (typeof body === 'object' && body !== null) {
      const rec = body as Record<string, unknown>;
      // ValidationPipe bodies are { message: string[], error: 'Bad Request' }:
      // check `message` first, because their `error` is a string too.
      if ('message' in rec) {
        const raw = rec.message;
        return {
          error: this.invalidRequestCode,
          error_description: Array.isArray(raw) ? raw.join('; ') : String(raw),
        };
      }
      if (typeof rec.error === 'string') {
        return typeof rec.error_description === 'string'
          ? { error: rec.error, error_description: rec.error_description }
          : { error: rec.error };
      }
    }
    return { error: this.invalidRequestCode };
  }
}

/** RFC 7591 §3.2.2: registration validation failures are invalid_client_metadata. */
@Injectable()
@Catch()
export class OAuthRegistrationExceptionFilter extends OAuthExceptionFilter {
  protected readonly invalidRequestCode: string = 'invalid_client_metadata';
}
