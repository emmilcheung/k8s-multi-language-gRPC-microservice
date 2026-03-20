import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use pino as the global logger
  app.useLogger(app.get(Logger));

  // Global validation pipe — strip unknown fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter — enforces standard error response shape
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
