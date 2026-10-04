import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import Stripe from 'stripe';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { OutboxRelayService } from './outbox-relay.service';
import { OrderServiceClient } from './order-service.client';
import { PAYMENT_VAULT_PROVIDER } from './payment-vault.provider';
import { StripePaymentVaultProvider } from './stripe-payment-vault.provider';
import { STRIPE_CLIENT } from './stripe.constants';
import { RefundExecutorService } from './refund-executor.service';
import {
  REFUND_PROVIDER,
  type RefundProvider,
  SimulatedRefundProvider,
  StripeRefundProvider,
} from './refund-provider';
import { SecurityModule } from '../../common/security/security.module';

@Module({
  imports: [PinoLoggerModule, SecurityModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    OutboxRelayService,
    RefundExecutorService,
    OrderServiceClient,
    StripePaymentVaultProvider,
    {
      provide: PAYMENT_VAULT_PROVIDER,
      useExisting: StripePaymentVaultProvider,
    },
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Stripe => {
        const secretKey = config.getOrThrow<string>('STRIPE_SECRET_KEY');
        return new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' });
      },
    },
    {
      // Simulated unless REFUND_PROVIDER=stripe; see refundConfigIssue for the live-key guard.
      provide: REFUND_PROVIDER,
      inject: [ConfigService, STRIPE_CLIENT],
      useFactory: (config: ConfigService, stripe: Stripe): RefundProvider =>
        config.get<string>('REFUND_PROVIDER') === 'stripe'
          ? new StripeRefundProvider(stripe)
          : new SimulatedRefundProvider(),
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
