import { Module } from "@nestjs/common";
import { AccountsRepository } from "./accounts.repository";
import { AccountsService } from "./accounts.service";
import { VenueClaimsService } from "./venue-claims.service";
import { PermissionsService } from "./permissions.service";

@Module({
  providers: [
    AccountsRepository,
    AccountsService,
    PermissionsService,
    VenueClaimsService,
  ],
  exports: [
    AccountsService,
    AccountsRepository,
    PermissionsService,
    VenueClaimsService,
  ],
})
export class AccountsModule {}
