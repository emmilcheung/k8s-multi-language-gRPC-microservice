import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// Swallow Kafka broker-unreachable errors that escape KafkaJS's internal retry
// mechanism. When Kafka is disabled in local dev, KafkaJSNumberOfRetriesExceeded is
// thrown asynchronously after onModuleInit returns. Depending on the Node.js version
// this surfaces as either an unhandledRejection or an uncaughtException — catch both.
function isKafkaUnavailableError(reason: unknown): boolean {
  const name = (reason as { name?: string })?.name ?? '';
  const message = (reason as { message?: string })?.message ?? String(reason);
  return name.startsWith('KafkaJS') || message.includes('ECONNREFUSED');
}

process.on('unhandledRejection', (reason: unknown) => {
  if (isKafkaUnavailableError(reason)) {
    const name = (reason as { name?: string })?.name ?? '';
    const msg = (reason as { message?: string })?.message ?? String(reason);
    console.warn(
      '[payment-service] Kafka unavailable (unhandledRejection), ignoring:',
      name,
      msg.slice(0, 120),
    );
    return;
  }
  console.error('[payment-service] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  if (isKafkaUnavailableError(err)) {
    console.warn(
      '[payment-service] Kafka unavailable (uncaughtException), ignoring:',
      err.name,
      err.message.slice(0, 120),
    );
    return;
  }
  console.error('[payment-service] Uncaught exception:', err);
  process.exit(1);
});

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

  // Global exception filter — enforces standard error response shape.
  // Resolved via DI so the filter can inject PinoLogger for structured error logging.
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
