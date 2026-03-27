import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const raw = config.getOrThrow<string>('RSA_PRIVATE_KEY');
        const privateKey = raw.includes('-----BEGIN')
          ? raw.replace(/\\n/g, '\n')
          : Buffer.from(raw, 'base64').toString('utf-8');
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
