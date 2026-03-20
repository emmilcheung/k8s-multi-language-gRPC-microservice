import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PAYMENT_STATUS } from '../../database/schema';
import type { Payment } from '../../database/schema';

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
  };
}

describe('PaymentsController.charge', () => {
  let service: ReturnType<typeof makeService>;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as any);
  });

  it('should throw BadRequestException when X-User-Id header is missing', async () => {
    await expect(
      controller.charge(undefined, { orderId: 'order-1', amount: 1000, token: 'pm_x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return created payment when charge succeeds', async () => {
    const payment = makePayment();
    service.charge.mockResolvedValue(payment);

    const result = await controller.charge('user-1', { orderId: 'order-1', amount: 1000, token: 'pm_x' });

    expect(service.charge).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', userId: 'user-1', amount: 1000 }),
    );
    expect(result).toEqual({ payment });
  });

  it('should propagate service exceptions up to the global exception filter', async () => {
    service.charge.mockRejectedValue(new InternalServerErrorException('fail'));

    await expect(
      controller.charge('user-1', { orderId: 'order-1', amount: 1000, token: 'pm_bad' }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});

describe('PaymentsController.findOne', () => {
  let service: ReturnType<typeof makeService>;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as any);
  });

  it('should return payment when found', async () => {
    const payment = makePayment();
    service.findById.mockResolvedValue(payment);

    const result = await controller.findOne('pay-uuid-1');
    expect(result).toEqual({ payment });
  });

  it('should propagate NotFoundException from service', async () => {
    service.findById.mockRejectedValue(new NotFoundException('not found'));

    await expect(controller.findOne('bad-id')).rejects.toThrow(NotFoundException);
  });
});
