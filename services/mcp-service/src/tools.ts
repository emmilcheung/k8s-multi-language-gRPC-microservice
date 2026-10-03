import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import { z } from 'zod';
import { deriveIdempotencyKey } from './idempotency.ts';
import {
  requireScope,
  scopesForTool,
  TOOL_SCOPES,
  type ToolName,
} from './scopes.ts';
import {
  ToolFailure,
  type Upstream,
  type UpstreamRequest,
  type UpstreamResponse,
} from './upstream.ts';

interface ToolDeps {
  upstream: Upstream;
  logger?: Pick<Logger, 'error'>;
  /** Public web origin, for the browser handoff. */
  publicWebUrl: string;
}

interface Env {
  call: (req: UpstreamRequest) => Promise<unknown>;
  /** Like `call`, plus whether order-service answered with an idempotent replay. */
  send: (req: UpstreamRequest) => Promise<UpstreamResponse>;
  sub: string;
}

const uuid = (what: string) => z.uuid().describe(what);
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/)
  .optional()
  .describe(
    'Optional. Identical arguments are already retry-safe: the same call twice returns the first order. Pass a fresh key to deliberately place another identical order.',
  );

/** Upstream list endpoints answer with a bare array; MCP structuredContent must be an object. */
const asItems = (data: unknown): { items: unknown[] } => ({
  items: Array.isArray(data) ? data : [],
});

/** Success payloads are JSON objects (MCP structuredContent); wrap anything else. */
const asObject = (data: unknown): Record<string, unknown> =>
  Array.isArray(data)
    ? { items: data }
    : data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : { value: data };

const succeed = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});

const fail = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  structuredContent: { code, ...extra },
});

// Output schemas, from the upstream services' real responses: the fields a
// caller relies on are typed (a response missing one becomes a tool error, see
// registerTools), everything else passes through. Sources:
//   order-service dto/OrderResponse.java, payment-service payments.controller.ts,
//   ticket-service handler/ticket_handler.go (ticketResponse),
//   venue-service hold/manager.go (AvailabilitySnapshot).
const orderShape = z.looseObject({
  id: z.string(),
  status: z.string(),
  quantity: z.number(),
  total: z.string().nullish(),
  expiresAt: z.string().nullish(),
  orderType: z.string().nullish(),
  planId: z.string().nullish(),
  ticket: z.looseObject({ id: z.string(), title: z.string() }).nullish(),
  seats: z.array(z.looseObject({})).nullish(),
});
const ticketShape = z.looseObject({
  id: z.string(),
  title: z.string(),
  price: z.string(),
  seatingPlanId: z.string().nullish(),
  quota: z.number().nullish(),
  reserved: z.number().nullish(),
  sold: z.number().nullish(),
  event: z.looseObject({}).nullish(),
});
const paymentShape = z.looseObject({
  id: z.string(),
  orderId: z.string(),
  status: z.string(),
});
const paymentMethodShape = z.looseObject({
  id: z.string(),
  brand: z.string(),
  last4: z.string(),
  isDefault: z.boolean(),
});

const orderOutput = orderShape;
const createdOrderOutput = orderShape.extend({ replayed: z.boolean() });
const ticketListOutput = z.looseObject({
  items: z.array(ticketShape),
});
const orderListOutput = z.looseObject({ items: z.array(orderShape) });
const paymentOutput = z.looseObject({ payment: paymentShape });
const methodsOutput = z.looseObject({
  paymentMethods: z.array(paymentMethodShape),
});
const availabilityOutput = z.looseObject({
  planId: z.string(),
  seatMap: z.record(z.string(), z.unknown()),
  counts: z.record(z.string(), z.number()),
});

const seg = encodeURIComponent;

interface ToolDef<I extends z.ZodObject> {
  name: ToolName;
  description: string;
  input: I;
  output: z.ZodObject;
  annotations: Record<string, boolean>;
  /** Ticket id for the browser handoff when the tool can hit the waiting room. */
  ticketId?: (args: z.infer<I>) => string;
  run: (args: z.infer<I>, env: Env) => Promise<Record<string, unknown>>;
}

const readOnly = { readOnlyHint: true };
const creates = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const destructive = { destructiveHint: true, idempotentHint: true };

/** Order plus whether this was an idempotent replay of an earlier identical call. */
const created = (res: UpstreamResponse): Record<string, unknown> => ({
  ...asObject(res.data),
  replayed: res.replayed,
});

const get = (env: Env, path: string) => env.call({ method: 'GET', path });

function defineTool<I extends z.ZodObject>(def: ToolDef<I>): ToolDef<I> {
  return def;
}

const TOOLS = [
  defineTool({
    name: 'search_events',
    description:
      'List the newest events and tickets (up to `limit`, max 100). Set available=false to include sold-out events. There is no server-side title search and no paging beyond this first page: scan the returned titles yourself.',
    input: z.object({
      available: z
        .boolean()
        .default(true)
        .describe('Only events with available tickets'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('How many of the newest events to return (max 100)'),
    }),
    output: ticketListOutput,
    annotations: readOnly,
    async run({ available, limit }, env) {
      const params = new URLSearchParams();
      if (available) params.set('available', 'true');
      params.set('limit', String(limit));
      return asItems(await get(env, `/api/tickets?${params.toString()}`));
    },
  }),
  defineTool({
    name: 'get_event',
    description:
      'Get full details for one event/ticket, including seating plan info.',
    input: z.object({ eventId: uuid('The ticket/event UUID') }),
    output: ticketShape,
    annotations: readOnly,
    async run({ eventId }, env) {
      return asObject(await get(env, `/api/tickets/${seg(eventId)}`));
    },
  }),
  defineTool({
    name: 'view_seat_availability',
    description:
      'View available seats for a seated event, with section layout and pricing.',
    input: z.object({
      seatingPlanId: uuid('The seating plan ID (found in event details)'),
    }),
    output: availabilityOutput,
    annotations: readOnly,
    async run({ seatingPlanId }, env) {
      return asObject(
        await get(env, `/api/seating-plans/${seg(seatingPlanId)}/availability`),
      );
    },
  }),
  defineTool({
    name: 'list_my_orders',
    description: "List the signed-in user's orders.",
    input: z.object({}),
    output: orderListOutput,
    annotations: readOnly,
    async run(_args, env) {
      return asItems(await get(env, '/api/orders'));
    },
  }),
  defineTool({
    name: 'get_order',
    description: 'Get one order by ID.',
    input: z.object({ orderId: uuid('The order UUID') }),
    output: orderOutput,
    annotations: readOnly,
    async run({ orderId }, env) {
      return asObject(await get(env, `/api/orders/${seg(orderId)}`));
    },
  }),
  defineTool({
    name: 'create_order',
    description:
      'Buy general-admission tickets. Reserves quota immediately; payment is a separate step. Safe to retry: identical arguments within about 15 minutes return the existing order (replayed: true) instead of creating another. If the replayed order is CANCELLED or EXPIRED, or you deliberately want another identical order, pass a new idempotencyKey.',
    input: z.object({
      ticketId: uuid('The ticket/event ID'),
      quantity: z.number().int().min(1).max(10).describe('Number of tickets'),
      idempotencyKey,
    }),
    output: createdOrderOutput,
    annotations: creates,
    ticketId: (a) => a.ticketId,
    async run({ idempotencyKey: key, ...body }, env) {
      return created(
        await env.send({
          method: 'POST',
          path: '/api/orders',
          body,
          idempotencyKey:
            key ?? deriveIdempotencyKey(env.sub, 'create_order', body),
        }),
      );
    },
  }),
  defineTool({
    name: 'create_seated_order',
    description:
      'Reserve specific seats (seatIds) or auto-assign seats from a section (sectionId + quantity) for a seated event. seatingPlanId comes from get_event. Payment is a separate step. Safe to retry: identical arguments within about 15 minutes return the existing order (replayed: true) instead of creating another. If the replayed order is CANCELLED or EXPIRED, or you deliberately want another identical order, pass a new idempotencyKey.',
    input: z
      .object({
        ticketId: uuid('The ticket/event ID'),
        seatingPlanId: uuid('Seating plan ID from get_event (seatingPlanId)'),
        seatIds: z
          .array(uuid('Seat ID'))
          .min(1)
          .max(50)
          .optional()
          .describe('Specific seats (manual selection)'),
        sectionId: uuid('Section ID for auto-assign').optional(),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Seats for auto-assign (with sectionId)'),
        idempotencyKey,
      })
      .refine(
        (a) =>
          a.seatIds
            ? a.sectionId === undefined && a.quantity === undefined
            : a.sectionId !== undefined && a.quantity !== undefined,
        {
          message:
            'Pass either seatIds (specific seats) or sectionId with quantity (auto-assign), not both.',
        },
      ),
    output: createdOrderOutput,
    annotations: creates,
    ticketId: (a) => a.ticketId,
    async run(
      {
        idempotencyKey: key,
        ticketId,
        seatingPlanId,
        seatIds,
        sectionId,
        quantity,
      },
      env,
    ) {
      // order-service CreateOrderRequest.validate(): planId is needed for both
      // seated flows; manual seats must come with quantity == seatIds.length.
      const body = seatIds
        ? { ticketId, planId: seatingPlanId, seatIds, quantity: seatIds.length }
        : { ticketId, planId: seatingPlanId, sectionId, quantity };
      return created(
        await env.send({
          method: 'POST',
          path: '/api/orders/seated',
          body,
          idempotencyKey:
            key ?? deriveIdempotencyKey(env.sub, 'create_seated_order', body),
        }),
      );
    },
  }),
  defineTool({
    name: 'cancel_order',
    description:
      'Cancel an order that is in a cancellable state. Refund policy applies.',
    input: z.object({ orderId: uuid('The order UUID to cancel') }),
    output: z.object({ orderId: z.string(), cancelled: z.boolean() }),
    annotations: { destructiveHint: true, idempotentHint: true },
    async run({ orderId }, env) {
      await env.call({ method: 'DELETE', path: `/api/orders/${seg(orderId)}` });
      return { orderId, cancelled: true };
    },
  }),
  defineTool({
    name: 'get_payment',
    description: 'Get one payment by ID.',
    input: z.object({ paymentId: uuid('The payment UUID') }),
    output: paymentOutput,
    annotations: readOnly,
    async run({ paymentId }, env) {
      return asObject(await get(env, `/api/payments/${seg(paymentId)}`));
    },
  }),
  defineTool({
    name: 'list_payment_methods',
    description:
      'List the saved payment methods (brand, last 4, expiry, default flag). Use before paying.',
    input: z.object({}),
    output: methodsOutput,
    annotations: readOnly,
    async run(_args, env) {
      return asObject(await get(env, '/api/payments/methods'));
    },
  }),
  defineTool({
    name: 'pay_for_order',
    description:
      'Charge a SAVED payment method for an order. Use list_payment_methods to get savedPaymentMethodId. Raw card data is never accepted. Charges real money.',
    input: z.object({
      orderId: uuid('The order UUID to pay for'),
      savedPaymentMethodId: uuid('ID from list_payment_methods'),
    }),
    output: paymentOutput,
    annotations: destructive,
    async run(body, env) {
      return asObject(
        await env.call({ method: 'POST', path: '/api/payments', body }),
      );
    },
  }),
  defineTool({
    name: 'pay_for_order_with_default',
    description:
      'Pay for an order with the default saved payment method in one step. Fails if no default is set. Charges real money.',
    input: z.object({ orderId: uuid('The order UUID to pay for') }),
    output: paymentOutput,
    annotations: destructive,
    async run({ orderId }, env) {
      const methods = asObject(await get(env, '/api/payments/methods'));
      const list = Array.isArray(methods.paymentMethods)
        ? methods.paymentMethods
        : [];
      const def = (list as { id?: unknown; isDefault?: unknown }[]).find(
        (m) => m.isDefault === true && typeof m.id === 'string',
      );
      if (!def) throw new ToolFailure('NO_DEFAULT_PAYMENT_METHOD');
      return asObject(
        await env.call({
          method: 'POST',
          path: '/api/payments',
          body: { orderId, savedPaymentMethodId: def.id },
        }),
      );
    },
  }),
];

/** Registers the twelve tools in TOOL_SCOPES order (deterministic listing). */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const byName = new Map<string, (typeof TOOLS)[number]>(
    TOOLS.map((t) => [t.name, t]),
  );
  for (const name of Object.keys(TOOL_SCOPES) as ToolName[]) {
    const def = byName.get(name);
    if (!def)
      throw new Error(`tool "${name}" has a scope but no implementation`);
    const scopes = scopesForTool(name);

    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.input,
        outputSchema: def.output,
        annotations: def.annotations,
        // the only source of step-up 403s; handlers never throw OAuthError.
        scopeChallenge: requireScope(...scopes),
      },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        const auth = ctx.http?.authInfo;
        if (!auth) return fail('UNAUTHORIZED', 'Authentication is required.');
        // The verifier rejects a token without a string `sub`. Never fall back to
        // the client id: it would key idempotency per client and merge users.
        const sub = auth.extra?.sub;
        if (typeof sub !== 'string' || !sub)
          return fail('UNAUTHORIZED', 'Authentication is required.');
        try {
          const send = (req: UpstreamRequest) =>
            deps.upstream.request(auth, name, req);
          const data = await (
            def.run as (a: unknown, e: Env) => Promise<Record<string, unknown>>
          )(args, {
            call: async (req) => (await send(req)).data,
            send,
            sub,
          });
          // A reply missing a key field is an upstream fault, not a success:
          // report the paths (never values) to operators, a fixed text to the model.
          const checked = def.output.safeParse(data);
          if (!checked.success) {
            deps.logger?.error(
              {
                tool: name,
                fields: checked.error.issues.map((i) => i.path.join('.')),
              },
              'upstream response does not match the tool output schema',
            );
            throw new ToolFailure('UPSTREAM_ERROR');
          }
          return succeed(data);
        } catch (err) {
          if (!(err instanceof ToolFailure)) {
            // Anything unexpected: fixed text out, only the tool and error
            // class in the log (messages can carry upstream text or secrets).
            deps.logger?.error(
              {
                tool: name,
                errorName: err instanceof Error ? err.name : typeof err,
              },
              'unexpected tool failure',
            );
            return fail(
              'UPSTREAM_ERROR',
              new ToolFailure('UPSTREAM_ERROR').message,
            );
          }
          if (err.code === 'WAITING_ROOM_ACTIVE' && def.ticketId) {
            const handoffUrl = `${deps.publicWebUrl.replace(/\/$/, '')}/tickets/${(def.ticketId as (a: unknown) => string)(args)}`;
            return fail(err.code, `${err.message} Continue at ${handoffUrl}`, {
              handoffUrl,
            });
          }
          return fail(err.code, err.message);
        }
      },
    );
  }
}
