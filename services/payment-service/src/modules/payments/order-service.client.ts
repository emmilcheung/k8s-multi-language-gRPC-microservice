import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Gauge, Registry, register } from 'prom-client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

const DEFAULT_CURRENCY = 'usd';
const DEFAULT_ORDER_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_ORDER_LOOKUP_RETRY_ATTEMPTS = 2;
const DEFAULT_ORDER_LOOKUP_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 30_000;
const DECIMAL_PRICE_RE = /^\d+(?:\.\d{1,2})?$/;
const LOOKUP_FAILURE_METRIC = 'payment_order_lookup_failures_total';
const LOOKUP_RETRY_METRIC = 'payment_order_lookup_retries_total';
const LOOKUP_BREAKER_METRIC = 'payment_order_lookup_circuit_breaker_open';

const orderResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  status: z.string(),
  quantity: z.number().int().positive(),
  ticket: z
    .object({
      price: z.union([z.string(), z.number()]),
      startsAt: z.string().optional(),
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
  total: z.union([z.string(), z.number()]).optional(),
});

type FailureReason =
  | 'circuit_open'
  | 'network_error'
  | 'timeout'
  | 'retry_exhausted'
  | 'status_5xx'
  | 'status_429'
  | 'unexpected_status'
  | 'invalid_payload';

type FailureLabels = 'reason';

export interface OrderSnapshot {
  orderId: string;
  userId: string;
  status: string;
  amount: number;
  currency: string;
  startsAt?: string;
}

function getOrCreateFailureCounter(registry: Registry): Counter<FailureLabels> {
  const existing = registry.getSingleMetric(LOOKUP_FAILURE_METRIC);
  if (existing) {
    return existing as Counter<FailureLabels>;
  }

  return new Counter<FailureLabels>({
    name: LOOKUP_FAILURE_METRIC,
    help: 'Total number of failed payment-service order lookups',
    labelNames: ['reason'],
    registers: [registry],
  });
}

function getOrCreateRetryCounter(registry: Registry): Counter<FailureLabels> {
  const existing = registry.getSingleMetric(LOOKUP_RETRY_METRIC);
  if (existing) {
    return existing as Counter<FailureLabels>;
  }

  return new Counter<FailureLabels>({
    name: LOOKUP_RETRY_METRIC,
    help: 'Total number of payment-service order lookup retry attempts',
    labelNames: ['reason'],
    registers: [registry],
  });
}

function getOrCreateBreakerGauge(registry: Registry): Gauge<string> {
  const existing = registry.getSingleMetric(LOOKUP_BREAKER_METRIC);
  if (existing) {
    return existing as Gauge<string>;
  }

  return new Gauge({
    name: LOOKUP_BREAKER_METRIC,
    help: 'Circuit breaker state for payment-service order lookups (1=open, 0=closed)',
    registers: [registry],
  });
}

class RetryableOrderLookupError extends Error {
  constructor(
    readonly reason: Extract<
      FailureReason,
      'network_error' | 'timeout' | 'status_5xx' | 'status_429'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'RetryableOrderLookupError';
  }
}

class NonRetryableOrderLookupError extends Error {
  constructor(
    readonly reason: Extract<FailureReason, 'unexpected_status' | 'invalid_payload'>,
    message: string,
  ) {
    super(message);
    this.name = 'NonRetryableOrderLookupError';
  }
}

@Injectable()
export class OrderServiceClient {
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private readonly failureCounter = getOrCreateFailureCounter(register);
  private readonly retryCounter = getOrCreateRetryCounter(register);
  private readonly breakerOpenGauge = getOrCreateBreakerGauge(register);

  constructor(
    @InjectPinoLogger(OrderServiceClient.name)
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
  ) {
    this.breakerOpenGauge.set(0);
  }

  async getOrderSnapshot(
    orderId: string,
    userId: string,
    userIdSig?: string,
  ): Promise<OrderSnapshot> {
    if (this.isCircuitOpen()) {
      this.failureCounter.inc({ reason: 'circuit_open' });
      this.logger.warn({ orderId, userId }, 'Order lookup circuit breaker is open');
      throw this.orderLookupFailed();
    }

    const baseUrl = this.config.getOrThrow<string>('ORDER_SERVICE_URL').replace(/\/$/, '');
    const timeoutMs = this.config.get<number>(
      'ORDER_SERVICE_TIMEOUT_MS',
      DEFAULT_ORDER_LOOKUP_TIMEOUT_MS,
    );
    const maxRetries = this.config.get<number>(
      'ORDER_SERVICE_RETRY_ATTEMPTS',
      DEFAULT_ORDER_LOOKUP_RETRY_ATTEMPTS,
    );
    const retryBaseDelayMs = this.config.get<number>(
      'ORDER_SERVICE_RETRY_BASE_DELAY_MS',
      DEFAULT_ORDER_LOOKUP_RETRY_BASE_DELAY_MS,
    );

    const headers: Record<string, string> = { 'X-User-Id': userId };
    if (userIdSig) {
      headers['X-User-Id-Sig'] = userIdSig;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.fetchOrder(
          `${baseUrl}/api/orders/${orderId}`,
          headers,
          timeoutMs,
        );
        const snapshot = await this.parseOrderResponse(response, orderId, userId);
        this.recordSuccess();
        return snapshot;
      } catch (err) {
        if (err instanceof NotFoundException) {
          this.recordSuccess();
          throw err;
        }

        if (err instanceof NonRetryableOrderLookupError) {
          this.failureCounter.inc({ reason: err.reason });
          this.recordFailure(orderId, userId, err.reason, err.message);
          throw this.orderLookupFailed();
        }

        const reason = err instanceof RetryableOrderLookupError ? err.reason : 'network_error';
        if (attempt >= maxRetries) {
          this.failureCounter.inc({ reason: 'retry_exhausted' });
          this.recordFailure(
            orderId,
            userId,
            reason,
            err instanceof Error ? err.message : 'Unknown error',
          );
          throw this.orderLookupFailed();
        }

        this.retryCounter.inc({ reason });
        this.logger.warn(
          { orderId, userId, attempt: attempt + 1, maxRetries, reason },
          'Transient order lookup failure — retrying',
        );
        await this.delay(this.computeRetryDelayMs(attempt, retryBaseDelayMs));
      }
    }

    throw this.orderLookupFailed();
  }

  private async fetchOrder(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const reason = this.isAbortError(err) ? 'timeout' : 'network_error';
      throw new RetryableOrderLookupError(reason, errorMessage);
    }
  }

  private async parseOrderResponse(
    response: Response,
    orderId: string,
    userId: string,
  ): Promise<OrderSnapshot> {
    if (response.status === 403 || response.status === 404) {
      throw new NotFoundException({
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
    }

    if (!response.ok) {
      const reason = this.retryableStatusReason(response.status);
      if (reason) {
        throw new RetryableOrderLookupError(reason, `Received retryable status ${response.status}`);
      }

      this.logger.warn(
        { orderId, userId, statusCode: response.status },
        'Order lookup returned a non-success status',
      );
      throw new NonRetryableOrderLookupError(
        'unexpected_status',
        `Received non-retryable status ${response.status}`,
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (err) {
      this.logger.error(
        { orderId, err: err instanceof Error ? err.message : 'Unknown error' },
        'Order lookup returned a non-JSON payload',
      );
      throw new NonRetryableOrderLookupError(
        'invalid_payload',
        'Order lookup returned invalid JSON',
      );
    }

    const payload = orderResponseSchema.safeParse(responseBody);
    if (!payload.success) {
      this.logger.error(
        { orderId, issues: payload.error.issues },
        'Order lookup returned an unexpected payload',
      );
      throw new NonRetryableOrderLookupError(
        'invalid_payload',
        'Order lookup returned an unexpected payload',
      );
    }

    return {
      orderId: payload.data.id,
      userId: payload.data.userId,
      status: payload.data.status,
      amount: this.computeAmount(payload.data),
      currency: DEFAULT_CURRENCY,
      startsAt: payload.data.ticket?.startsAt,
    };
  }

  private retryableStatusReason(
    statusCode: number,
  ): Extract<FailureReason, 'status_5xx' | 'status_429'> | null {
    if (statusCode === 429) {
      return 'status_429';
    }

    if (statusCode >= 500 && statusCode < 600) {
      return 'status_5xx';
    }

    return null;
  }

  private computeRetryDelayMs(attempt: number, baseDelayMs: number): number {
    const exponentialDelay = baseDelayMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * Math.max(baseDelayMs, 1));
    return exponentialDelay + jitter;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'TimeoutError';
  }

  private isCircuitOpen(): boolean {
    if (this.breakerOpenUntil === 0) {
      return false;
    }

    if (Date.now() >= this.breakerOpenUntil) {
      this.breakerOpenUntil = 0;
      this.consecutiveFailures = 0;
      this.breakerOpenGauge.set(0);
      this.logger.info(
        'Order lookup circuit breaker reset window elapsed; allowing requests again',
      );
      return false;
    }

    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    this.breakerOpenGauge.set(0);
  }

  private recordFailure(
    orderId: string,
    userId: string,
    reason: FailureReason,
    errorMessage: string,
  ): void {
    this.consecutiveFailures += 1;
    this.logger.warn(
      { orderId, userId, reason, consecutiveFailures: this.consecutiveFailures, err: errorMessage },
      'Order lookup failed',
    );

    const failureThreshold = this.config.get<number>(
      'ORDER_SERVICE_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
      DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    );

    if (this.consecutiveFailures < failureThreshold) {
      return;
    }

    const resetTimeoutMs = this.config.get<number>(
      'ORDER_SERVICE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
      DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    );
    this.breakerOpenUntil = Date.now() + resetTimeoutMs;
    this.breakerOpenGauge.set(1);
    this.logger.warn(
      { orderId, userId, reason, resetTimeoutMs, failureThreshold },
      'Order lookup circuit breaker opened',
    );
  }

  private computeAmount(order: z.infer<typeof orderResponseSchema>): number {
    if (order.total != null) {
      return this.decimalToMinorUnits(order.total);
    }

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
