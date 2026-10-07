import { Module } from "@nestjs/common";
import { AccountsRepository } from "./accounts.repository";
import { AccountsService } from "./accounts.service";
import { PermissionsService } from "./permissions.service";

@Module({
  providers: [AccountsRepository, AccountsService, PermissionsService],
  exports: [AccountsService, AccountsRepository, PermissionsService],
})
export class AccountsModule {}
