import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Logger } from "nestjs-pino";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";

export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));
}
