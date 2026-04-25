import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserIdSignatureValidator } from "./user-id-signature.validator";

@Module({
  providers: [
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
  exports: [UserIdSignatureValidator],
})
export class SecurityModule {}
