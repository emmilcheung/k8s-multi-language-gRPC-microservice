import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { RefreshTokenService } from './refresh-token.service';
import { RedisModule } from '../redis/redis.module';
import { parseRsaPrivateKey } from './rsa-key.util';

@Module({
  imports: [
    // RedisModule must be imported here (not just relied on as @Global from AppModule)
    // so that AuthModule is self-contained when loaded in integration tests without
    // AppModule. NestJS deduplicates module instances, so only one Redis client
    // is created regardless of how many modules import RedisModule.
    RedisModule,
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const privateKey = parseRsaPrivateKey(
          config.getOrThrow<string>('RSA_PRIVATE_KEY'),
        );
        return {
          privateKey,
          signOptions: {
            algorithm: 'RS256' as const,
            expiresIn: config.get<string>('JWT_EXPIRY', '15m') as StringValue,
            issuer: 'auth-service',
          },
        };
      },
    }),
  ],
  providers: [AuthService, RefreshTokenService],
  controllers: [AuthController],
})
export class AuthModule {}
