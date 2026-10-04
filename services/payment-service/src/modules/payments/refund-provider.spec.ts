import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  SimulatedRefundProvider,
  StripeRefundProvider,
  refundConfigIssue,
} from './refund-provider';

describe('SimulatedRefundProvider', () => {
  // Retries reuse the idempotency key; like Stripe, they must land on the same
  // refund rather than look like a second one.
  it('refund should return the same id when called again with the same idempotency key', async () => {
    const provider = new SimulatedRefundProvider();
    const request = { paymentIntentId: 'pi_1', amount: 500, idempotencyKey: 'refund:r1' };

    const first = await provider.refund(request);
    const second = await provider.refund(request);
    const other = await provider.refund({ ...request, idempotencyKey: 'refund:r2' });

    expect(first.providerRefundId).toMatch(/^sim_re_/);
    expect(second.providerRefundId).toBe(first.providerRefundId);
    expect(other.providerRefundId).not.toBe(first.providerRefundId);
  });
});

describe('StripeRefundProvider', () => {
  it('refund should pass the idempotency key to Stripe when refunding a payment intent', async () => {
    const create = vi.fn().mockResolvedValue({ id: 're_123' });
    const provider = new StripeRefundProvider({ refunds: { create } } as unknown as Stripe);

    const result = await provider.refund({
      paymentIntentId: 'pi_1',
      amount: 500,
      idempotencyKey: 'refund:r1',
    });

    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 500 },
      { idempotencyKey: 'refund:r1' },
    );
    expect(result.providerRefundId).toBe('re_123');
  });

  it('refund should throw without calling Stripe when the payment has no payment intent', async () => {
    const create = vi.fn();
    const provider = new StripeRefundProvider({ refunds: { create } } as unknown as Stripe);

    await expect(
      provider.refund({ paymentIntentId: null, amount: 500, idempotencyKey: 'refund:r1' }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('refundConfigIssue', () => {
  // Real money must only move when someone switched it on on purpose.
  it('refundConfigIssue should reject the stripe provider when the key is live and live refunds are not allowed', () => {
    expect(
      refundConfigIssue({
        REFUND_PROVIDER: 'stripe',
        REFUND_ALLOW_LIVE: false,
        STRIPE_SECRET_KEY: 'sk_live_abc',
      }),
    ).not.toBeNull();
  });

  it('refundConfigIssue should accept the stripe provider when the key is live and live refunds are allowed', () => {
    expect(
      refundConfigIssue({
        REFUND_PROVIDER: 'stripe',
        REFUND_ALLOW_LIVE: true,
        STRIPE_SECRET_KEY: 'sk_live_abc',
      }),
    ).toBeNull();
  });

  it('refundConfigIssue should accept the stripe provider when the key is a test key', () => {
    expect(
      refundConfigIssue({
        REFUND_PROVIDER: 'stripe',
        REFUND_ALLOW_LIVE: false,
        STRIPE_SECRET_KEY: 'sk_test_abc',
      }),
    ).toBeNull();
  });

  it('refundConfigIssue should accept the simulated provider when the key is live', () => {
    expect(
      refundConfigIssue({
        REFUND_PROVIDER: 'simulated',
        REFUND_ALLOW_LIVE: false,
        STRIPE_SECRET_KEY: 'sk_live_abc',
      }),
    ).toBeNull();
  });
});
