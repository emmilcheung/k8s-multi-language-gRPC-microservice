import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_STATUS } from '../../database/schema';
import type { Payment } from '../../database/schema';

type MockFn = ReturnType<typeof vi.fn>;
type PaymentsServiceMock = {
  charge: MockFn;
  findById: MockFn;
  processOrderCreatedEvent: MockFn;
  constructWebhookEvent: MockFn;
  handleStripeEvent: MockFn;
  failStripePayment: MockFn;
  completeStripePayment: MockFn;
};

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-uuid-1',
    orderId: 'order-uuid-1',
    userId: 'user-uuid-1',
    amount: 1000,
    currency: 'usd',
    status: PAYMENT_STATUS.COMPLETED,
    stripePaymentIntentId: 'pi_abc',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  return {
    charge: vi.fn(),
    findById: vi.fn(),
    processOrderCreatedEvent: vi.fn(),
    constructWebhookEvent: vi.fn(),
    handleStripeEvent: vi.fn(),
    failStripePayment: vi.fn(),
    completeStripePayment: vi.fn(),
  };
}

describe('PaymentsController.charge', () => {
  let service: PaymentsServiceMock;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  it('should throw BadRequestException when X-User-Id header is missing', async () => {
    await expect(
      controller.charge(undefined, { orderId: 'order-1', token: 'pm_x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return created payment when charge succeeds', async () => {
    const payment = makePayment();
    service.charge.mockResolvedValue(payment);

    const result = await controller.charge('user-1', {
      orderId: 'order-1',
      token: 'pm_x',
    });

    expect(service.charge).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', userId: 'user-1', token: 'pm_x' }),
    );
    expect(result).toEqual({ payment });
  });

  it('should propagate service exceptions up to the global exception filter', async () => {
    service.charge.mockRejectedValue(new InternalServerErrorException('fail'));

    await expect(
      controller.charge('user-1', { orderId: 'order-1', token: 'pm_bad' }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});

describe('PaymentsController.findOne', () => {
  let service: PaymentsServiceMock;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  it('should return payment when authenticated owner requests it', async () => {
    const payment = makePayment({ userId: 'user-uuid-1' });
    service.findById.mockResolvedValue(payment);

    const result = await controller.findOne('pay-uuid-1', 'user-uuid-1');
    expect(result).toEqual({ payment });
  });

  it('should throw UnauthorizedException when X-User-Id header is missing', async () => {
    await expect(controller.findOne('pay-uuid-1', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.findById).not.toHaveBeenCalled();
  });

  it('should throw NotFoundException when payment does not exist', async () => {
    service.findById.mockResolvedValue(null);

    await expect(controller.findOne('bad-id', 'user-uuid-1')).rejects.toThrow(NotFoundException);
  });

  it('should throw ForbiddenException when user does not own the payment', async () => {
    const payment = makePayment({ userId: 'owner-uuid' });
    service.findById.mockResolvedValue(payment);

    await expect(controller.findOne('pay-uuid-1', 'attacker-uuid')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
