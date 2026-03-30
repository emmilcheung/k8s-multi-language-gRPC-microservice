import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { trace } from '@opentelemetry/api';
import { DatabaseModule } from './database/database.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { OrdersConsumer } from './kafka/orders.consumer';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string(),
  STRIPE_SECRET_KEY: z.string(),
  KAFKA_BROKERS: z.string(),
});

/** Inject the active OTel traceId and spanId into every pino log line (O-02). */
function otelMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const ctx = (span as { spanContext(): { traceId: string; spanId: string } }).spanContext();

  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

@Module({
  imports: [
    // ── Config ──────────────────────────────────────────────────────────────
    // Validates all required env vars at startup — fails loudly if missing
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const result = envSchema.safeParse(config);
        if (!result.success) {
          throw new Error(
            `Config validation failed:\n${result.error.issues
              .map((e) => `  ${e.path.join('.')}: ${e.message}`)
              .join('\n')}`,
          );
        }
        return result.data;
      },
    }),

    // ── Structured JSON logging (pino) ───────────────────────────────────────
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get('NODE_ENV') === 'production' ? 'info' : 'debug',
          transport:
            config.get('NODE_ENV') !== 'production'
              ? { target: 'pino-pretty', options: { colorize: true } }
              : undefined,
          // Inject OTel traceId + spanId into every log line (O-02)
          mixin: otelMixin,
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          serializers: {
            req(req: { method: string; url: string }) {
              return { method: req.method, url: req.url };
            },
          },
        },
      }),
    }),

    // ── Feature modules ──────────────────────────────────────────────────────
    DatabaseModule,
    ScheduleModule.forRoot(),
    PaymentsModule,
    HealthModule,
    MetricsModule,
  ],
  // OrdersConsumer lives at app level so tests can exclude it without touching PaymentsModule
  providers: [OrdersConsumer],
})
export class AppModule {}
