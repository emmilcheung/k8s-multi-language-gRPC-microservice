import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use pino as the global logger — replaces NestJS default logger
  app.useLogger(app.get(Logger));

  // Parse cookies (httpOnly JWT cookie)
  app.use(cookieParser());

  // Global validation pipe — strip unknown fields, forbid extra properties
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter — enforces standard error response shape.
  // Resolved via DI so the filter can inject PinoLogger for structured error logging.
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
