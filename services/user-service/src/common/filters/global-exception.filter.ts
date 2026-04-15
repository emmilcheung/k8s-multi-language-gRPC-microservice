import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import type { Response } from "express";
import { Logger } from "nestjs-pino";

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

      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as Record<string, unknown>).error === "object" &&
        (body as Record<string, unknown>).error !== null
      ) {
        return response.status(status).json(body);
      }

      if (typeof body === "object" && body !== null && "message" in body) {
        const messageBody = body as { message: string | string[] };
        const details = Array.isArray(messageBody.message)
          ? messageBody.message.map((issue) => ({ issue }))
          : [{ issue: messageBody.message }];

        return response.status(status).json({
          error: {
            code: "VALIDATION_FAILED",
            message: "Request validation failed",
            details,
          },
        });
      }

      return response.status(status).json({
        error: {
          code: "HTTP_ERROR",
          message: typeof body === "string" ? body : JSON.stringify(body),
        },
      });
    }

    this.logger.error(
      { err: exception },
      "[GlobalExceptionFilter] Unhandled error",
    );
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
  }
}
