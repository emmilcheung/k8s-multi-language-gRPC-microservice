import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { AuthResolver } from './auth.resolver';
import { UsersModule } from '../modules/users/users.module';
import { SecurityModule } from '../common/security/security.module';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    UsersModule,
    SecurityModule,
  ],
  providers: [AuthResolver, UserIdSigGuard],
})
export class AuthGraphQLModule {}
