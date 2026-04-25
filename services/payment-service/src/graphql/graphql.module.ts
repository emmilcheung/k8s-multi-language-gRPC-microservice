import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { PaymentResolver } from './payment.resolver';
import { PaymentsModule } from '../modules/payments/payments.module';
import { SecurityModule } from '../common/security/security.module';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    PaymentsModule,
    SecurityModule,
  ],
  providers: [PaymentResolver, UserIdSigGuard],
})
export class PaymentGraphQLModule {}
