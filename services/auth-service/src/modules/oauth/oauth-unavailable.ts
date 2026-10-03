import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * A CIMD client document could not be fetched right now (overload, timeout,
 * connect or DNS trouble). Unlike a verdict on the document it is retryable, so
 * it must not look like a terminal invalid_client: a refreshing client would
 * discard its credentials.
 */
export class OAuthTemporarilyUnavailableException extends ServiceUnavailableException {
  constructor(readonly retryAfterSeconds: number) {
    super({
      error: 'temporarily_unavailable',
      error_description:
        'The client metadata document is temporarily unavailable; retry later',
    });
  }
}

export function sendTemporarilyUnavailable(
  response: Response,
  e: OAuthTemporarilyUnavailableException,
): void {
  response.setHeader('Retry-After', String(e.retryAfterSeconds));
  response.setHeader('Cache-Control', 'no-store');
  response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
    error: 'temporarily_unavailable',
    error_description: (e.getResponse() as { error_description: string })
      .error_description,
  });
}

/** For /oauth/authorize, which otherwise keeps the global error shape. */
@Catch(OAuthTemporarilyUnavailableException)
export class OAuthUnavailableFilter implements ExceptionFilter {
  catch(exception: OAuthTemporarilyUnavailableException, host: ArgumentsHost) {
    sendTemporarilyUnavailable(
      host.switchToHttp().getResponse<Response>(),
      exception,
    );
  }
}
