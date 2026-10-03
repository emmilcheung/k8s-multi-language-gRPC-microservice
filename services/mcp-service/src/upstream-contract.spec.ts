import { describe, expect, it } from 'vitest';
import { TOOL_SCOPES } from './scopes.ts';
import {
  DEFAULT_PAYMENT_METHOD,
  ERAS,
  connect,
  harness,
  mintToken,
} from './testkit.ts';

const TICKET = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const PLAN = '66666666-6666-4666-8666-666666666666';
const SEAT_A = '77777777-7777-4777-8777-777777777777';
const SEAT_B = '88888888-8888-4888-8888-888888888888';
const SECTION = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '55555555-5555-4555-8555-555555555555';
const SAVED = '33333333-3333-4333-8333-333333333333';
const ALL_SCOPES = [...new Set(Object.values(TOOL_SCOPES))].join(' ');

interface Expected {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Create calls carry a derived Idempotency-Key; nothing else does. */
  idempotent?: true;
}
interface Row {
  tool: string;
  args: Record<string, unknown>;
  /** Scope string the token exchange must request. */
  scope: string;
  calls: Expected[];
  /** Where the expected values come from; they are NOT read off tools.ts. */
  source: string;
}

// Expected values are written from the upstream services' own code. The class
// of bug this guards: a stub that accepts any request hid a seated-order body
// that order-service rejects.
const ROWS: Row[] = [
  {
    tool: 'search_events',
    args: {},
    scope: 'tickets:read',
    // ticket-service internal/handler/ticket_handler.go:238-262 reads only limit, after, available.
    source: 'ticket_handler.go ListTickets',
    calls: [
      {
        method: 'GET',
        path: '/api/tickets',
        query: { available: 'true', limit: '20' },
      },
    ],
  },
  {
    tool: 'search_events',
    // `after` is ticket-service's opaque <createdAtUnixMilli>:<id> cursor, which REST never
    // returns; a stale `after` argument must not reach the wire.
    args: { available: false, limit: 5, after: TICKET },
    scope: 'tickets:read',
    source:
      'ticket_handler.go ListTickets (first page only; available omitted = unfiltered)',
    calls: [
      {
        method: 'GET',
        path: '/api/tickets',
        query: { limit: '5' },
      },
    ],
  },
  {
    // ticket-service has no title search, so a stale `query` argument must
    // not turn into a `search=` parameter that is silently ignored upstream.
    tool: 'search_events',
    args: { query: 'rock concerts' },
    scope: 'tickets:read',
    source: 'ticket_handler.go ListTickets (no search param exists)',
    calls: [
      {
        method: 'GET',
        path: '/api/tickets',
        query: { available: 'true', limit: '20' },
      },
    ],
  },
  {
    tool: 'get_event',
    args: { eventId: TICKET },
    scope: 'tickets:read',
    source: 'ticket_handler.go GetTicket, GET /api/tickets/:id',
    calls: [{ method: 'GET', path: `/api/tickets/${TICKET}` }],
  },
  {
    tool: 'view_seat_availability',
    args: { seatingPlanId: PLAN },
    scope: 'seating:read',
    source:
      'venue-service seat_hold_handler.go:39 GET /api/seating-plans/:planId/availability',
    calls: [{ method: 'GET', path: `/api/seating-plans/${PLAN}/availability` }],
  },
  {
    tool: 'list_my_orders',
    args: {},
    scope: 'orders:read',
    source: 'order-service OrderController.listOrders GET /api/orders',
    calls: [{ method: 'GET', path: '/api/orders' }],
  },
  {
    tool: 'get_order',
    args: { orderId: ORDER },
    scope: 'orders:read',
    source: 'OrderController.getOrder GET /api/orders/{id}',
    calls: [{ method: 'GET', path: `/api/orders/${ORDER}` }],
  },
  {
    tool: 'create_order',
    args: { ticketId: TICKET, quantity: 2 },
    scope: 'orders:create',
    source: 'CreateOrderRequest.java (GA: ticketId + quantity>=1)',
    calls: [
      {
        method: 'POST',
        path: '/api/orders',
        body: { ticketId: TICKET, quantity: 2 },
        idempotent: true,
      },
    ],
  },
  {
    tool: 'create_seated_order',
    args: { ticketId: TICKET, seatingPlanId: PLAN, seatIds: [SEAT_A, SEAT_B] },
    scope: 'orders:create',
    // CreateOrderRequest.validate(): MANUAL_SEATED needs quantity == seatIds.size();
    // OrderService.createSeatedOrder looks up the plan by planId for every seated order.
    source: 'CreateOrderRequest.validate MANUAL_SEATED + OrderService:228-251',
    calls: [
      {
        method: 'POST',
        path: '/api/orders/seated',
        body: {
          ticketId: TICKET,
          planId: PLAN,
          seatIds: [SEAT_A, SEAT_B],
          quantity: 2,
        },
        idempotent: true,
      },
    ],
  },
  {
    tool: 'create_seated_order',
    args: {
      ticketId: TICKET,
      seatingPlanId: PLAN,
      sectionId: SECTION,
      quantity: 3,
    },
    scope: 'orders:create',
    // validate(): AUTO_ASSIGN_SEATED needs sectionId, planId and quantity >= 1.
    source: 'CreateOrderRequest.validate AUTO_ASSIGN_SEATED',
    calls: [
      {
        method: 'POST',
        path: '/api/orders/seated',
        body: {
          ticketId: TICKET,
          planId: PLAN,
          sectionId: SECTION,
          quantity: 3,
        },
        idempotent: true,
      },
    ],
  },
  {
    tool: 'cancel_order',
    args: { orderId: ORDER },
    scope: 'orders:cancel',
    source: 'OrderController.cancelOrder DELETE /api/orders/{id}',
    calls: [{ method: 'DELETE', path: `/api/orders/${ORDER}` }],
  },
  {
    tool: 'get_payment',
    args: { paymentId: PAYMENT },
    scope: 'payments:read',
    source: 'payments.controller.ts findOne GET /api/payments/:id',
    calls: [{ method: 'GET', path: `/api/payments/${PAYMENT}` }],
  },
  {
    tool: 'list_payment_methods',
    args: {},
    scope: 'payments:read',
    source:
      'payments.controller.ts listSavedPaymentMethods GET /api/payments/methods',
    calls: [{ method: 'GET', path: '/api/payments/methods' }],
  },
  {
    tool: 'pay_for_order',
    args: { orderId: ORDER, savedPaymentMethodId: SAVED },
    scope: 'payments:create',
    source: 'payments.dto.ts ChargeDto (orderId + savedPaymentMethodId)',
    calls: [
      {
        method: 'POST',
        path: '/api/payments',
        body: { orderId: ORDER, savedPaymentMethodId: SAVED },
      },
    ],
  },
  {
    tool: 'pay_for_order_with_default',
    args: { orderId: ORDER },
    scope: 'payments:create payments:read',
    // Kong guards methods with payments:read and POST /api/payments with payments:create.
    source:
      'payments.controller.ts methods + charge; kong.base.yml scope guards',
    calls: [
      { method: 'GET', path: '/api/payments/methods' },
      {
        method: 'POST',
        path: '/api/payments',
        body: { orderId: ORDER, savedPaymentMethodId: DEFAULT_PAYMENT_METHOD },
      },
    ],
  },
];

describe.each(ERAS)('upstream call contract (%s)', (era) => {
  it('covers all twelve tools', () => {
    expect(new Set(ROWS.map((r) => r.tool))).toEqual(
      new Set(Object.keys(TOOL_SCOPES)),
    );
  });

  it.each(ROWS)(
    '$tool $args sends exactly what the upstream expects ($source)',
    async ({ tool, args, scope, calls }) => {
      const h = harness();
      const client = await connect(
        era,
        await mintToken({ scope: ALL_SCOPES }),
        h.viaApp,
      );
      const res = await client.callTool({ name: tool, arguments: args });
      expect(res.isError, JSON.stringify(res)).toBeFalsy();

      expect(h.calls).toHaveLength(calls.length);
      calls.forEach((want, i) => {
        const got = h.calls[i];
        expect(got.method).toBe(want.method);
        expect(got.url.pathname).toBe(want.path);
        expect(Object.fromEntries(got.url.searchParams)).toEqual(
          want.query ?? {},
        );
        expect(got.body).toEqual(want.body);
        expect(got.headers.get('authorization')).toBe(
          'Bearer api-audience-token',
        );
        const key = got.headers.get('idempotency-key');
        if (want.idempotent) expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        else expect(key).toBeNull();
      });

      // Least privilege: one exchange, narrowed to this tool's scope(s),
      // for the API audience (pinned literal: auth-service OAUTH_API_AUDIENCE).
      expect(h.exchanges).toHaveLength(1);
      expect(Object.fromEntries(h.exchanges[0])).toMatchObject({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        scope,
        resource: 'http://localhost:8000/api',
      });
      await client.close();
    },
  );
});

describe('exchange audience', () => {
  const exchangeResource = async (config?: { API_AUDIENCE?: string }) => {
    const h = harness(undefined, { config });
    const client = await connect(
      ERAS[1],
      await mintToken({ scope: 'orders:read' }),
      h.viaApp,
    );
    await client.callTool({ name: 'list_my_orders', arguments: {} });
    await client.close();
    return h.exchanges[0]?.get('resource');
  };

  it('uses the explicit API_AUDIENCE, so it matches auth-service even where deriving from MCP_RESOURCE would not', async () => {
    expect(
      await exchangeResource({ API_AUDIENCE: 'https://shop.example.com/api' }),
    ).toBe('https://shop.example.com/api');
  });

  it('falls back to <MCP_RESOURCE origin>/api when API_AUDIENCE is unset', async () => {
    expect(await exchangeResource()).toBe('http://localhost:8000/api');
  });
});
