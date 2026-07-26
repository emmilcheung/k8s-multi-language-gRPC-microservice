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
import { GraphQLError } from "graphql";

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // For GraphQL (or other non-HTTP) contexts there is no Express Response —
    // calling response.status(...) would throw TypeError. Re-throw so the
    // GraphQL driver formats the error itself.
    if (host.getType<"http" | "graphql" | "rpc" | "ws">() !== "http") {
      throw this.toGraphQLError(exception);
    }

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

  // Mirror the REST { code, message } shape onto a GraphQLError so Apollo
  // surfaces a meaningful message instead of the exception class name.
  private toGraphQLError(exception: unknown): GraphQLError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message = exception.message;
      let code: string | undefined;
      if (typeof body === "object" && body !== null) {
        const rec = body as Record<string, unknown>;
        const errField = rec["error"];
        if (typeof errField === "object" && errField !== null) {
          const err = errField as Record<string, unknown>;
          if (typeof err["message"] === "string") message = err["message"];
          if (typeof err["code"] === "string") code = err["code"];
        } else if ("message" in rec) {
          const raw = rec["message"];
          message = Array.isArray(raw) ? raw.join("; ") : String(raw);
        }
      } else if (typeof body === "string") {
        message = body;
      }
      // Intentionally not setting extensions.http.status — standard GraphQL
      // returns HTTP 200 with errors in the body; the resolver-level status is
      // surfaced via extensions.statusCode for clients that want it.
      return new GraphQLError(message, {
        extensions: { code, statusCode: status },
      });
    }
    this.logger.error(
      { err: exception },
      "[GlobalExceptionFilter] Unhandled error (non-http)",
    );
    return new GraphQLError("An unexpected error occurred", {
      extensions: { code: "INTERNAL_ERROR" },
    });
  }
}
