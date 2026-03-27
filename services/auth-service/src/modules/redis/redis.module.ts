import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Injection token for the ioredis client.
 * Import this symbol wherever you need to inject the Redis client directly.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Global Redis module — provides a single shared ioredis client.
 * Marked @Global() so every feature module can inject REDIS_CLIENT
 * without importing RedisModule explicitly.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const url = config.getOrThrow<string>('REDIS_URL');
        return new Redis(url, {
          // Fail loudly on initial connect — surface misconfiguration at boot
          lazyConnect: false,
          // Limit retries so the process crashes instead of hanging forever
          // during startup if Redis is unreachable.
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
        });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
