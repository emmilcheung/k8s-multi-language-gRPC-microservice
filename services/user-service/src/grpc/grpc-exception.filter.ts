import {
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { RpcException } from "@nestjs/microservices";
import { status } from "@grpc/grpc-js";
import { Observable, throwError } from "rxjs";

// Turns the service layer's HTTP-flavoured errors into gRPC statuses. Anything
// unexpected becomes INTERNAL with no detail: the caller must not see internals.
@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown): Observable<never> {
    if (exception instanceof RpcException) {
      return throwError(() => exception.getError());
    }
    if (exception instanceof HttpException) {
      const http = exception.getStatus();
      const code =
        http === (HttpStatus.NOT_FOUND as number)
          ? status.NOT_FOUND
          : http === (HttpStatus.BAD_REQUEST as number)
            ? status.INVALID_ARGUMENT
            : status.INTERNAL;
      if (code !== status.INTERNAL) {
        return throwError(() => ({ code, message: exception.message }));
      }
    }
    this.logger.error(
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception),
    );
    return throwError(() => ({
      code: status.INTERNAL,
      message: "Internal error",
    }));
  }
}
