import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { trace } from '@opentelemetry/api';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { OAuthModule } from './modules/oauth/oauth.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './modules/redis/redis.module';
import { SecurityModule } from './common/security/security.module';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  RSA_PRIVATE_KEY: z.string(),
  JWT_EXPIRY: z.string().default('15m'),
  JWT_COOKIE_NAME: z.string().default('token'),
  REFRESH_COOKIE_NAME: z.string().default('refreshToken'),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),
  SIGNIN_FAILURE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  SIGNIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  SIGNIN_LOCKOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_COOKIE_PATH: z.string().default('/'),
  ACCESS_TOKEN_COOKIE_SAME_SITE: z
    .enum(['strict', 'lax', 'none'])
    .default('strict'),
  REFRESH_TOKEN_COOKIE_SAME_SITE: z
    .enum(['strict', 'lax', 'none'])
    .default('strict'),
  COOKIE_DOMAIN: z.string().optional(),
  REDIS_URL: z.string(),
  // OAuth2 redirect helpers — used by OAuthService to build cross-service URLs.
  KONG_BASE_URL: z.string().url().default('http://localhost:8000'),
  OAUTH_CLIENT_BASE_URL: z.string().url().default('http://localhost:4000'),
  X_USER_ID_SIGNING_KEY: z.string().optional().default(''),
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
    SecurityModule,
    RedisModule,
    UsersModule,
    AuthModule,
    OAuthModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
