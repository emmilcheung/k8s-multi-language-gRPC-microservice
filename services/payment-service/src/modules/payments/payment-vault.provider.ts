export const PAYMENT_VAULT_PROVIDER = 'PAYMENT_VAULT_PROVIDER';

export interface PaymentVaultProvider {
  ensureCustomer(userId: string): Promise<{
    provider: 'stripe';
    providerCustomerId: string;
  }>;

  attachPaymentMethod(params: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<{
    providerPaymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    fingerprint?: string | null;
  }>;

  detachPaymentMethod(providerPaymentMethodId: string): Promise<void>;
}
