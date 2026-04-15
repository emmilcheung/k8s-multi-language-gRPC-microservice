import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { STRIPE_CLIENT } from './stripe.constants';
import { type PaymentVaultProvider } from './payment-vault.provider';

@Injectable()
export class StripePaymentVaultProvider implements PaymentVaultProvider {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly config: ConfigService,
  ) {}

  private get isMockMode(): boolean {
    return this.config.get<string>('STRIPE_SECRET_KEY')?.includes('test_mock') ?? false;
  }

  async ensureCustomer(
    userId: string,
  ): Promise<{ provider: 'stripe'; providerCustomerId: string }> {
    if (this.isMockMode) {
      const safeUserId = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'user';
      return {
        provider: 'stripe',
        providerCustomerId: `mock_cus_${safeUserId}`,
      };
    }

    const customer = await this.stripe.customers.create({
      metadata: { userId },
    });

    return {
      provider: 'stripe',
      providerCustomerId: customer.id,
    };
  }

  async attachPaymentMethod(params: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<{
    providerPaymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    fingerprint?: string | null;
  }> {
    if (this.isMockMode) {
      const digits = params.providerPaymentMethodId.replace(/\D/g, '').padEnd(4, '0');
      const last4 = digits.slice(-4);
      return {
        providerPaymentMethodId: params.providerPaymentMethodId,
        brand: 'visa',
        last4,
        expMonth: 12,
        expYear: 2099,
        fingerprint: `fp_mock_${last4}`,
      };
    }

    const attached = await this.stripe.paymentMethods.attach(params.providerPaymentMethodId, {
      customer: params.providerCustomerId,
    });

    const card = attached.card;
    if (!card) {
      throw new Error('Attached payment method is not a card');
    }

    return {
      providerPaymentMethodId: attached.id,
      brand: card.brand ?? 'unknown',
      last4: card.last4 ?? '0000',
      expMonth: card.exp_month ?? 1,
      expYear: card.exp_year ?? 1970,
      fingerprint: card.fingerprint,
    };
  }

  async detachPaymentMethod(providerPaymentMethodId: string): Promise<void> {
    if (this.isMockMode) {
      return;
    }

    await this.stripe.paymentMethods.detach(providerPaymentMethodId);
  }
}
