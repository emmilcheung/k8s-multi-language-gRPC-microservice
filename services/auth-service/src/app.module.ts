import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { trace } from '@opentelemetry/api';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './modules/redis/redis.module';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  RSA_PRIVATE_KEY: z.string(),
  JWT_EXPIRY: z.string().default('15m'),
  REDIS_URL: z.string(),
});

/** Inject the active OTel traceId and spanId into every pino log line (O-02). */
function otelMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const ctx = (
    span as { spanContext(): { traceId: string; spanId: string } }
  ).spanContext();

  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

@Module({
  imports: [
    // ── Config ──────────────────────────────────────────────────────────────
    // Validates all required env vars at startup — fails loudly if anything is missing
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
          // Never log sensitive fields
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
    RedisModule,
    UsersModule,
    AuthModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
