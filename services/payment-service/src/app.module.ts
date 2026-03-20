import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';
import { DatabaseModule } from './database/database.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { OrdersConsumer } from './kafka/orders.consumer';

@Module({
  imports: [
    // ── Config ──────────────────────────────────────────────────────────────
    // Validates all required env vars at startup — fails loudly if missing
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().default(3001),
        DATABASE_URL: Joi.string().required(),
        STRIPE_SECRET_KEY: Joi.string().required(),
        KAFKA_BROKERS: Joi.string().required(),
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
    PaymentsModule,
    HealthModule,
    MetricsModule,
  ],
  // OrdersConsumer lives at app level so tests can exclude it without touching PaymentsModule
  providers: [OrdersConsumer],
})
export class AppModule {}
