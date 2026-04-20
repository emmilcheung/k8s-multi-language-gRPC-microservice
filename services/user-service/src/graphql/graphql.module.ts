import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { UserResolver } from './user.resolver';
import { UserSettingsModule } from '../modules/user-settings/user-settings.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    UserSettingsModule,
  ],
  providers: [UserResolver],
})
export class UserGraphQLModule {}
