import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { OAuthCodeStoreService } from './oauth-code-store.service';

@Module({
  imports: [
    // RedisModule provides REDIS_CLIENT for OAuthCodeStoreService
    RedisModule,
    // AuthModule (with exports) provides AuthService, RefreshTokenService, UsersRepository
    AuthModule,
  ],
  providers: [OAuthService, OAuthCodeStoreService],
  controllers: [OAuthController],
})
export class OAuthModule {}
