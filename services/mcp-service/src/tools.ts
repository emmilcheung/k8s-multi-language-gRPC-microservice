import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
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
} from './upstream.ts';

interface ToolDeps {
  upstream: Upstream;
  /** Public web origin, for the C-9 browser handoff. */
  publicWebUrl: string;
}

type Call = (req: UpstreamRequest) => Promise<unknown>;
interface Env {
  call: Call;
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

// Upstream response shapes belong to other services; only fields the tools
// themselves rely on are declared, the rest passes through.
const anyObject = z.looseObject({});

interface ToolDef<I extends z.ZodObject> {
  name: ToolName;
  description: string;
  input: I;
  output?: z.ZodObject;
  annotations: Record<string, boolean>;
  /** Ticket id for the C-9 handoff when the tool can hit the waiting room. */
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

const get = (env: Env, path: string) => env.call({ method: 'GET', path });

function defineTool<I extends z.ZodObject>(def: ToolDef<I>): ToolDef<I> {
  return def;
}

const TOOLS = [
  defineTool({
    name: 'search_events',
    description:
      'Search events and tickets by title, availability, or pagination cursor.',
    input: z.object({
      query: z.string().optional().describe('Search term for event title'),
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
        .describe('Max results'),
      after: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous response'),
    }),
    annotations: readOnly,
    async run({ query, available, limit, after }, env) {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      if (available) params.set('available', 'true');
      params.set('limit', String(limit));
      if (after) params.set('after', after);
      return asObject(await get(env, `/api/tickets?${params.toString()}`));
    },
  }),
  defineTool({
    name: 'get_event',
    description:
      'Get full details for one event/ticket, including seating plan info.',
    input: z.object({ eventId: uuid('The ticket/event UUID') }),
    annotations: readOnly,
    async run({ eventId }, env) {
      return asObject(await get(env, `/api/tickets/${eventId}`));
    },
  }),
  defineTool({
    name: 'view_seat_availability',
    description:
      'View available seats for a seated event, with section layout and pricing.',
    input: z.object({
      seatingPlanId: uuid('The seating plan ID (found in event details)'),
    }),
    annotations: readOnly,
    async run({ seatingPlanId }, env) {
      return asObject(
        await get(env, `/api/seating-plans/${seatingPlanId}/availability`),
      );
    },
  }),
  defineTool({
    name: 'list_my_orders',
    description: "List the signed-in user's orders.",
    input: z.object({}),
    annotations: readOnly,
    async run(_args, env) {
      return asObject(await get(env, '/api/orders'));
    },
  }),
  defineTool({
    name: 'get_order',
    description: 'Get one order by ID.',
    input: z.object({ orderId: uuid('The order UUID') }),
    annotations: readOnly,
    async run({ orderId }, env) {
      return asObject(await get(env, `/api/orders/${orderId}`));
    },
  }),
  defineTool({
    name: 'create_order',
    description:
      'Buy general-admission tickets. Reserves quota immediately; payment is a separate step. Safe to retry with the same arguments.',
    input: z.object({
      ticketId: uuid('The ticket/event ID'),
      quantity: z.number().int().min(1).max(10).describe('Number of tickets'),
      idempotencyKey,
    }),
    annotations: creates,
    ticketId: (a) => a.ticketId,
    async run({ idempotencyKey: key, ...body }, env) {
      return asObject(
        await env.call({
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
      'Reserve specific seats (seatIds) or auto-assign seats from a section (sectionId + quantity) for a seated event. Payment is a separate step. Safe to retry with the same arguments.',
    input: z.object({
      ticketId: uuid('The ticket/event ID'),
      seatIds: z
        .array(uuid('Seat ID'))
        .optional()
        .describe('Specific seats (manual selection)'),
      sectionId: uuid('Section ID for auto-assign').optional(),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Seats for auto-assign'),
      idempotencyKey,
    }),
    annotations: creates,
    ticketId: (a) => a.ticketId,
    async run(
      { idempotencyKey: key, ticketId, seatIds, sectionId, quantity },
      env,
    ) {
      const body = seatIds?.length
        ? { ticketId, seatIds }
        : { ticketId, sectionId, quantity };
      return asObject(
        await env.call({
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
      await env.call({ method: 'DELETE', path: `/api/orders/${orderId}` });
      return { orderId, cancelled: true };
    },
  }),
  defineTool({
    name: 'get_payment',
    description: 'Get one payment by ID.',
    input: z.object({ paymentId: uuid('The payment UUID') }),
    annotations: readOnly,
    async run({ paymentId }, env) {
      return asObject(await get(env, `/api/payments/${paymentId}`));
    },
  }),
  defineTool({
    name: 'list_payment_methods',
    description:
      'List the saved payment methods (brand, last 4, expiry, default flag). Use before paying.',
    input: z.object({}),
    output: z.looseObject({ paymentMethods: z.array(anyObject).optional() }),
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

/** Registers the twelve C-7 tools in TOOL_SCOPES order (deterministic listing). */
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
        outputSchema: def.output ?? anyObject,
        annotations: def.annotations,
        // C-6: the only source of step-up 403s; handlers never throw OAuthError.
        scopeChallenge: requireScope(...scopes),
      },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        const auth = ctx.http?.authInfo;
        if (!auth) return fail('UNAUTHORIZED', 'Authentication is required.');
        const sub =
          typeof auth.extra?.sub === 'string' ? auth.extra.sub : auth.clientId;
        try {
          const data = await (
            def.run as (a: unknown, e: Env) => Promise<Record<string, unknown>>
          )(args, {
            call: (req) => deps.upstream.request(auth, name, req),
            sub,
          });
          return succeed(data);
        } catch (err) {
          if (!(err instanceof ToolFailure)) throw err;
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
