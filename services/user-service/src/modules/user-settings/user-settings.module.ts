import { Module } from "@nestjs/common";
import { UserSettingsController } from "./user-settings.controller";
import { UserSettingsRepository } from "./user-settings.repository";
import { UserSettingsService } from "./user-settings.service";

@Module({
  controllers: [UserSettingsController],
  providers: [UserSettingsRepository, UserSettingsService],
})
export class UserSettingsModule {}
