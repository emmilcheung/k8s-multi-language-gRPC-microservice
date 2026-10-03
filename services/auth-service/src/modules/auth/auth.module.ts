import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createPublicKey } from 'crypto';
import type { StringValue } from 'ms';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { RefreshTokenService } from './refresh-token.service';
import { SigninAbuseProtectionService } from './signin-abuse-protection.service';
import { RedisModule } from '../redis/redis.module';
import { SecurityModule } from '../../common/security/security.module';
import { readOAuthConfig } from '../oauth/oauth-config';
import { parseRsaPrivateKey } from './rsa-key.util';

/** JwtModule options: signs browser + OAuth tokens, verifies both issuers. Exported for tests. */
export function buildJwtOptions(config: ConfigService): JwtModuleOptions {
  const privateKey = parseRsaPrivateKey(
    config.getOrThrow<string>('RSA_PRIVATE_KEY'),
  );
  // Derive the public key from the private key so JwtService can both
  // sign (privateKey) and verify (publicKey) tokens in the same module.
  // This is needed for the defense-in-depth verification in currentUser.
  const publicKey = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  return {
    privateKey,
    publicKey,
    signOptions: {
      algorithm: 'RS256' as const,
      expiresIn: config.get<string>('JWT_EXPIRY', '15m') as StringValue,
      issuer: 'auth-service',
    },
    verifyOptions: {
      algorithms: ['RS256'],
      // OAuth tokens carry OAUTH_ISSUER once the rollout flips OAUTH_ISSUER_ENABLED.
      issuer: ['auth-service', readOAuthConfig(config).issuer],
    },
  };
}

@Module({
  imports: [
    // RedisModule must be imported here (not just relied on as @Global from AppModule)
    // so that AuthModule is self-contained when loaded in integration tests without
    // AppModule. NestJS deduplicates module instances, so only one Redis client
    // is created regardless of how many modules import RedisModule.
    RedisModule,
    SecurityModule,
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: buildJwtOptions,
    }),
  ],
  providers: [AuthService, RefreshTokenService, SigninAbuseProtectionService],
  controllers: [AuthController],
  exports: [AuthService, RefreshTokenService, UsersModule, JwtModule],
})
export class AuthModule {}
