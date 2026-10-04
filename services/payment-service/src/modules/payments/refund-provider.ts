import { createHash } from 'crypto';
import type Stripe from 'stripe';

/** Injection token for the RefundProvider. */
export const REFUND_PROVIDER = 'REFUND_PROVIDER';

export interface RefundRequest {
  /** Stripe PaymentIntent the refund is taken from; null when the charge never reached Stripe. */
  paymentIntentId: string | null;
  /** Amount in the smallest currency unit. */
  amount: number;
  /** Same key for every attempt at one refund, so a retry can never refund twice. */
  idempotencyKey: string;
}

/**
 * The last step of a refund: actually returning the money. Everything before it
 * (claiming the row, status changes, events, audit) is the same whichever
 * provider is configured, so the whole flow can run without the real refund API.
 */
export interface RefundProvider {
  readonly name: 'simulated' | 'stripe';
  refund(request: RefundRequest): Promise<{ providerRefundId: string }>;
}

/**
 * Default provider. Makes no network call and returns a refund id derived from
 * the idempotency key, so a retried attempt gets the same id, as Stripe would.
 */
export class SimulatedRefundProvider implements RefundProvider {
  readonly name = 'simulated' as const;

  refund(request: RefundRequest): Promise<{ providerRefundId: string }> {
    const digest = createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 24);
    return Promise.resolve({ providerRefundId: `sim_re_${digest}` });
  }
}

/** Calls Stripe `refunds.create`. Opt-in via REFUND_PROVIDER=stripe. */
export class StripeRefundProvider implements RefundProvider {
  readonly name = 'stripe' as const;

  constructor(private readonly stripe: Stripe) {}

  async refund(request: RefundRequest): Promise<{ providerRefundId: string }> {
    if (!request.paymentIntentId) {
      throw new Error('Payment has no Stripe PaymentIntent to refund');
    }
    const refund = await this.stripe.refunds.create(
      { payment_intent: request.paymentIntentId, amount: request.amount },
      { idempotencyKey: request.idempotencyKey },
    );
    return { providerRefundId: refund.id };
  }
}

/**
 * Startup check for the refund settings. Returns a message when the settings
 * are unsafe, or null when they are fine. Real refunds must be switched on
 * knowingly: the Stripe provider with a live key is refused unless
 * REFUND_ALLOW_LIVE is set, so a misplaced key can't move real money.
 */
export function refundConfigIssue(config: {
  REFUND_PROVIDER: 'simulated' | 'stripe';
  REFUND_ALLOW_LIVE: boolean;
  STRIPE_SECRET_KEY: string;
}): string | null {
  if (
    config.REFUND_PROVIDER === 'stripe' &&
    config.STRIPE_SECRET_KEY.startsWith('sk_live_') &&
    !config.REFUND_ALLOW_LIVE
  ) {
    return 'REFUND_PROVIDER=stripe with a live STRIPE_SECRET_KEY requires REFUND_ALLOW_LIVE=true';
  }
  return null;
}
