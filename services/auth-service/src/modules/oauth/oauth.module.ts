import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { OAuthMetadataController } from './oauth-metadata.controller';
import { OAuthCodeStoreService } from './oauth-code-store.service';
import { DynamicClientService } from './dynamic-client.service';
import { OAuthConsentStoreService } from './oauth-consent-store.service';
import { CimdClientService } from './cimd-client.service';
import { SecurityModule } from '../../common/security/security.module';

@Module({
  imports: [
    // RedisModule provides REDIS_CLIENT for OAuthCodeStoreService and DynamicClientService
    RedisModule,
    // AuthModule (with exports) provides AuthService, RefreshTokenService, UsersRepository
    AuthModule,
    SecurityModule,
  ],
  providers: [
    OAuthService,
    OAuthCodeStoreService,
    DynamicClientService,
    OAuthConsentStoreService,
    CimdClientService,
  ],
  controllers: [OAuthController, OAuthMetadataController],
})
export class OAuthModule {}
