import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

const DEFAULT_CURRENCY = 'usd';
const DEFAULT_ORDER_LOOKUP_TIMEOUT_MS = 5_000;
const DECIMAL_PRICE_RE = /^\d+(?:\.\d{1,2})?$/;

const orderResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  status: z.string(),
  quantity: z.number().int().positive(),
  ticket: z
    .object({
      price: z.union([z.string(), z.number()]),
    })
    .nullable()
    .optional(),
  seats: z
    .array(
      z.object({
        price: z.union([z.string(), z.number()]),
      }),
    )
    .optional()
    .default([]),
});

export interface OrderSnapshot {
  orderId: string;
  userId: string;
  status: string;
  amount: number;
  currency: string;
}

@Injectable()
export class OrderServiceClient {
  constructor(
    @InjectPinoLogger(OrderServiceClient.name)
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
  ) {}

  async getOrderSnapshot(orderId: string, userId: string): Promise<OrderSnapshot> {
    const baseUrl = this.config.getOrThrow<string>('ORDER_SERVICE_URL').replace(/\/$/, '');
    const timeoutMs = this.config.get<number>(
      'ORDER_SERVICE_TIMEOUT_MS',
      DEFAULT_ORDER_LOOKUP_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/orders/${orderId}`, {
        headers: { 'X-User-Id': userId },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        { err: errorMessage, orderId, userId },
        'Order lookup failed before receiving a response',
      );
      throw this.orderLookupFailed();
    }

    if (response.status === 403 || response.status === 404) {
      throw new NotFoundException({
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
    }

    if (!response.ok) {
      this.logger.warn(
        { orderId, userId, statusCode: response.status },
        'Order lookup returned a non-success status',
      );
      throw this.orderLookupFailed();
    }

    const responseBody: unknown = await response.json();
    const payload = orderResponseSchema.safeParse(responseBody);
    if (!payload.success) {
      this.logger.error(
        { orderId, issues: payload.error.issues },
        'Order lookup returned an unexpected payload',
      );
      throw this.orderLookupFailed();
    }

    return {
      orderId: payload.data.id,
      userId: payload.data.userId,
      status: payload.data.status,
      amount: this.computeAmount(payload.data),
      currency: DEFAULT_CURRENCY,
    };
  }

  private computeAmount(order: z.infer<typeof orderResponseSchema>): number {
    if (order.seats.length > 0) {
      return order.seats.reduce((sum, seat) => sum + this.decimalToMinorUnits(seat.price), 0);
    }

    if (!order.ticket) {
      throw this.orderLookupFailed();
    }

    return this.decimalToMinorUnits(order.ticket.price) * order.quantity;
  }

  private decimalToMinorUnits(value: string | number): number {
    const normalized = typeof value === 'number' ? value.toFixed(2) : value.trim();

    if (!DECIMAL_PRICE_RE.test(normalized)) {
      throw this.orderLookupFailed();
    }

    const [wholePart, fractionalPart = ''] = normalized.split('.');
    return Number(wholePart) * 100 + Number(fractionalPart.padEnd(2, '0'));
  }

  private orderLookupFailed(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      error: {
        code: 'ORDER_LOOKUP_FAILED',
        message: 'Unable to verify order details',
      },
    });
  }
}
