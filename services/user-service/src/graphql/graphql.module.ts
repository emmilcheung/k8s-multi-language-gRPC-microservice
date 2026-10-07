import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from "@nestjs/apollo";
import {
  UserResolver,
  UserSettingsMutationResolver,
  UserProfileResolver,
} from "./user.resolver";
import { AccountsResolver } from "./accounts.resolver";
import { AccountsModule } from "../modules/accounts/accounts.module";
import { UserLoader } from "./users.loader";
import { UserSettingsModule } from "../modules/user-settings/user-settings.module";
import { SecurityModule } from "../common/security/security.module";
import { UserIdSigGuard } from "./guards/user-id-sig.guard";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + "/schema.graphql"],
      playground: false,
    }),
    UserSettingsModule,
    AccountsModule,
    SecurityModule,
  ],
  providers: [
    UserResolver,
    UserSettingsMutationResolver,
    UserProfileResolver,
    AccountsResolver,
    UserLoader,
    UserIdSigGuard,
  ],
})
export class UserGraphQLModule {}
