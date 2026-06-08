import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderServiceClient } from './order-service.client';

type ConfigValueMap = Record<string, string | number>;

function makeConfig(values: ConfigValueMap): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue,
    ),
    getOrThrow: vi.fn((key: string) => {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        throw new Error(`Missing config for ${key}`);
      }

      return values[key];
    }),
  } as unknown as ConfigService;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeClient(overrides: ConfigValueMap = {}) {
  const logger = makeLogger();
  const config = makeConfig({
    ORDER_SERVICE_URL: 'http://order-service:8082',
    ORDER_SERVICE_TIMEOUT_MS: 10,
    ORDER_SERVICE_RETRY_ATTEMPTS: 1,
    ORDER_SERVICE_RETRY_BASE_DELAY_MS: 0,
    ORDER_SERVICE_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
    ORDER_SERVICE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 1_000,
    ...overrides,
  });

  return { client: new OrderServiceClient(logger as never, config), logger };
}

function makeOrderResponse(status = 200): Response {
  return new Response(
    JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      status: 'created',
      quantity: 2,
      ticket: { price: '12.50' },
      seats: [],
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('OrderServiceClient', () => {
  beforeEach(() => {
    register.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient failure and returns the eventual success response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(makeOrderResponse());
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient();
    const snapshot = await client.getOrderSnapshot(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snapshot.amount).toBe(2500);
  });

  it('throws service unavailable after retry exhaustion', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('upstream reset'));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient({ ORDER_SERVICE_RETRY_ATTEMPTS: 2 });

    await expect(
      client.getOrderSnapshot('11111111-1111-4111-8111-111111111111', 'user-1'),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([403, 404])('does not retry on %s responses', async (statusCode) => {
    const fetchMock = vi.fn().mockResolvedValue(makeOrderResponse(statusCode));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient({ ORDER_SERVICE_RETRY_ATTEMPTS: 3 });

    await expect(
      client.getOrderSnapshot('11111111-1111-4111-8111-111111111111', 'user-1'),
    ).rejects.toThrow(NotFoundException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit breaker after repeated failures and resets after cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T00:00:00.000Z'));

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(makeOrderResponse());
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient({
      ORDER_SERVICE_RETRY_ATTEMPTS: 0,
      ORDER_SERVICE_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
      ORDER_SERVICE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 500,
    });

    await expect(
      client.getOrderSnapshot('11111111-1111-4111-8111-111111111111', 'user-1'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      client.getOrderSnapshot('11111111-1111-4111-8111-111111111111', 'user-1'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      client.getOrderSnapshot('11111111-1111-4111-8111-111111111111', 'user-1'),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-04-30T00:00:01.000Z'));

    const snapshot = await client.getOrderSnapshot(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(snapshot.currency).toBe('usd');
  });

  it('uses total from order payload when present instead of computing from seats/quantity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          status: 'created',
          quantity: 2,
          ticket: { price: '12.50' },
          seats: [],
          total: '112.98',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient();
    const snapshot = await client.getOrderSnapshot(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    );

    expect(snapshot.amount).toBe(11298);
  });

  it('accepts a null ticket.startsAt without failing order verification', async () => {
    // order-service REST serialises a missing replica start date as null (not
    // undefined). The schema must tolerate it, otherwise the whole order lookup
    // fails with ORDER_LOOKUP_FAILED and payment cannot proceed.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          status: 'created',
          quantity: 1,
          ticket: { price: '55.00', startsAt: null },
          seats: [],
          total: '62.00',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client } = makeClient();
    const snapshot = await client.getOrderSnapshot(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    );

    expect(snapshot.amount).toBe(6200);
    expect(snapshot.startsAt).toBeUndefined();
  });
});
