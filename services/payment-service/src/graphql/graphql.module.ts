import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { PaymentResolver } from './payment.resolver';
import { PaymentsModule } from '../modules/payments/payments.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    PaymentsModule,
  ],
  providers: [PaymentResolver],
})
export class PaymentGraphQLModule {}
