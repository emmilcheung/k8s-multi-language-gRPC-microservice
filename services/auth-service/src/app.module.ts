import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';
import * as otelApi from '@opentelemetry/api';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './modules/redis/redis.module';

/** Inject the active OTel traceId and spanId into every pino log line (O-02). */
function otelMixin(): Record<string, string> {
  const span = otelApi.trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}

@Module({
  imports: [
    // ── Config ──────────────────────────────────────────────────────────────
    // Validates all required env vars at startup — fails loudly if anything is missing
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().default(3000),
        DATABASE_URL: Joi.string().required(),
        RSA_PRIVATE_KEY: Joi.string().required(),
        JWT_EXPIRY: Joi.string().default('15m'),
        COOKIE_DOMAIN: Joi.string().default('localhost'),
        REDIS_URL: Joi.string().required(),
      }),
      validationOptions: { abortEarly: false },
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
