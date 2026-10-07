import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserIdSignatureValidator } from "./user-id-signature.validator";
import { PlatformRolesVerifier } from "./platform-roles.verifier";

@Module({
  providers: [
    {
      provide: PlatformRolesVerifier,
      useFactory: (configService: ConfigService) =>
        new PlatformRolesVerifier(
          configService.get<string>("X_USER_ID_SIGNING_KEY", ""),
        ),
      inject: [ConfigService],
    },
    {
      provide: UserIdSignatureValidator,
      useFactory: (configService: ConfigService) => {
        const signingKey = configService.get<string>(
          "X_USER_ID_SIGNING_KEY",
          "",
        );
        return new UserIdSignatureValidator(signingKey);
      },
      inject: [ConfigService],
    },
  ],
  exports: [UserIdSignatureValidator, PlatformRolesVerifier],
})
export class SecurityModule {}
