import { Module } from "@nestjs/common";
import { SecurityModule } from "../../common/security/security.module";
import { UserIdSigRestGuard } from "../../common/security/user-id-sig-rest.guard";
import { UserSettingsController } from "./user-settings.controller";
import { UserSettingsRepository } from "./user-settings.repository";
import { UserSettingsService } from "./user-settings.service";

@Module({
  imports: [SecurityModule],
  controllers: [UserSettingsController],
  providers: [UserSettingsRepository, UserSettingsService, UserIdSigRestGuard],
  exports: [UserSettingsService],
})
export class UserSettingsModule {}
