import { describe, expect, it } from 'vitest';
import { TOOL_SCOPES } from './scopes.ts';
import {
  DEFAULT_PAYMENT_METHOD,
  ERAS,
  connect,
  harness,
  mintToken,
  realisticReply,
  testConfig,
} from './testkit.ts';

const TICKET = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const ALL_SCOPES = [...new Set(Object.values(TOOL_SCOPES))].join(' ');

describe.each(ERAS)('MCP tools (%s)', (era) => {
  it('J-1: lists the twelve C-7 tools in a deterministic order, each with an outputSchema', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOL_SCOPES));
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
    await client.close();
  });

  it('J-1: annotations follow C-7 (reads are readOnly; writes are non-destructive+idempotent; cancel and pay are destructive)', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const { tools } = await client.listTools();
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      'search_events',
      'get_event',
      'view_seat_availability',
      'list_my_orders',
      'get_order',
      'get_payment',
      'list_payment_methods',
    ]) {
      expect(ann[name], name).toMatchObject({ readOnlyHint: true });
    }
    for (const name of ['create_order', 'create_seated_order']) {
      expect(ann[name], name).toMatchObject({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    for (const name of [
      'cancel_order',
      'pay_for_order',
      'pay_for_order_with_default',
    ]) {
      expect(ann[name], name).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
      });
    }
    await client.close();
  });

  it('J-1: pay_for_order accepts saved methods only: no raw paymentToken input can reach Stripe through an agent', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === 'pay_for_order')!;
    expect(Object.keys(pay.inputSchema.properties ?? {})).toEqual([
      'orderId',
      'savedPaymentMethodId',
    ]);
    await client.close();
  });

  it('J-2: create_order with only tickets:read is refused with HTTP 403 insufficient_scope asking for held + required', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: 'tickets:read' }),
      h.viaApp,
    );
    await client
      .callTool({
        name: 'create_order',
        arguments: { ticketId: TICKET, quantity: 1 },
      })
      .catch(() => undefined);
    const refused = h.responses.find((r) => r.status === 403);
    expect(refused, 'a 403 reached the client').toBeDefined();
    const challenge = refused!.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="tickets:read orders:create"');
    expect(challenge).toContain('resource_metadata="');
    expect(h.calls, 'nothing was sent upstream').toHaveLength(0);
    await client.close();
  });

  it('J-2: pay_for_order_with_default also asks for payments:read, because it lists methods before paying', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: 'tickets:read' }),
      h.viaApp,
    );
    await client
      .callTool({
        name: 'pay_for_order_with_default',
        arguments: { orderId: ORDER },
      })
      .catch(() => undefined);
    const challenge =
      h.responses
        .find((r) => r.status === 403)
        ?.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(
      'scope="tickets:read payments:create payments:read"',
    );
    await client.close();
  });

  it('J-3: the same args twice send the same Idempotency-Key, so a retry replays instead of double-ordering', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const args = { ticketId: TICKET, quantity: 2 };
    await client.callTool({ name: 'create_order', arguments: args });
    await client.callTool({
      name: 'create_order',
      arguments: { quantity: 2, ticketId: TICKET },
    });
    await client.callTool({
      name: 'create_order',
      arguments: { ticketId: TICKET, quantity: 3 },
    });
    const keys = h.calls.map((c) => c.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2], 'different args must not collide').not.toBe(keys[0]);
    await client.close();
  });

  it('J-3: an explicit idempotencyKey wins over the derived one', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    await client.callTool({
      name: 'create_order',
      arguments: {
        ticketId: TICKET,
        quantity: 1,
        idempotencyKey: 'caller-chosen-key-1',
      },
    });
    expect(h.calls[0].headers.get('idempotency-key')).toBe(
      'caller-chosen-key-1',
    );
    await client.close();
  });

  it('J-4: a Kong waiting-room 403 becomes WAITING_ROOM_ACTIVE with a browser handoffUrl, not a dead end', async () => {
    const h = harness(() =>
      Response.json(
        { message: 'waiting room: pass required' },
        { status: 403 },
      ),
    );
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const res = await client.callTool({
      name: 'create_order',
      arguments: { ticketId: TICKET, quantity: 1 },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({
      code: 'WAITING_ROOM_ACTIVE',
      handoffUrl: `${testConfig.PUBLIC_WEB_URL}/tickets/${TICKET}`,
    });
    expect(res.content[0].text).toContain('browser');
    await client.close();
  });

  it('J-4: a 403 that is not the waiting room is a plain refusal, never a handoff', async () => {
    const h = harness(() =>
      Response.json({ message: 'forbidden' }, { status: 403 }),
    );
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const res = await client.callTool({
      name: 'create_order',
      arguments: { ticketId: TICKET, quantity: 1 },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('FORBIDDEN');
    expect(res.structuredContent).not.toHaveProperty('handoffUrl');
    await client.close();
  });

  it('J-6: an upstream 500 body never appears in the tool result', async () => {
    const leak = 'postgres://svc:hunter2@db/orders stack at Object.<anonymous>';
    const h = harness(() => new Response(leak, { status: 500 }));
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const res = await client.callTool({
      name: 'get_order',
      arguments: { orderId: ORDER },
    });
    expect(res.isError).toBe(true);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('postgres');
    expect(res.structuredContent?.code).toBe('UPSTREAM_ERROR');
    await client.close();
  });

  it('J-6: neither the MCP token nor the exchanged token reaches a tool result', async () => {
    const token = await mintToken({ scope: ALL_SCOPES });
    const h = harness();
    const client = await connect(era, token, h.viaApp);
    const res = await client.callTool({
      name: 'get_order',
      arguments: { orderId: ORDER },
    });
    const wire = JSON.stringify(res);
    expect(wire).not.toContain(token);
    expect(wire).not.toContain('api-audience-token');
    await client.close();
  });

  it('J-5: upstream gets the exchanged API-audience token, never the MCP-audience one (C-5)', async () => {
    const token = await mintToken({ scope: ALL_SCOPES });
    const h = harness();
    const client = await connect(era, token, h.viaApp);
    await client.callTool({ name: 'get_order', arguments: { orderId: ORDER } });
    expect(h.calls[0].headers.get('authorization')).toBe(
      'Bearer api-audience-token',
    );
    expect(h.calls[0].url.href).toBe(
      `${testConfig.KONG_INTERNAL_URL}/api/orders/${ORDER}`,
    );
    await client.close();
  });

  it('J-3: 409 EXHAUSTED and 422 REUSED become distinct, sanitised errors the agent can act on', async () => {
    for (const [status, code] of [
      [409, 'IDEMPOTENCY_KEY_EXHAUSTED'],
      [422, 'IDEMPOTENCY_KEY_REUSED'],
    ] as const) {
      const h = harness(() =>
        Response.json(
          { error: { code, message: 'SECRET-DETAIL' } },
          { status },
        ),
      );
      const client = await connect(
        era,
        await mintToken({ scope: ALL_SCOPES }),
        h.viaApp,
      );
      const res = await client.callTool({
        name: 'create_order',
        arguments: { ticketId: TICKET, quantity: 1 },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent?.code).toBe(code);
      expect(JSON.stringify(res)).not.toContain('SECRET-DETAIL');
      await client.close();
    }
  });

  it('pay_for_order sends only the saved method id and order id upstream', async () => {
    const h = harness();
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const pm = '33333333-3333-4333-8333-333333333333';
    await client.callTool({
      name: 'pay_for_order',
      arguments: { orderId: ORDER, savedPaymentMethodId: pm },
    });
    expect(h.calls[0].method).toBe('POST');
    expect(h.calls[0].url.pathname).toBe('/api/payments');
    expect(h.calls[0].body).toEqual({
      orderId: ORDER,
      savedPaymentMethodId: pm,
    });
    await client.close();
  });

  it('pay_for_order_with_default charges the default method and fails clearly when there is none', async () => {
    const pmDefault = DEFAULT_PAYMENT_METHOD;
    const method = (id: string, isDefault: boolean) => ({
      id,
      brand: 'visa',
      last4: '4242',
      isDefault,
    });
    const h = harness((c) =>
      c.method === 'GET'
        ? Response.json({
            paymentMethods: [
              method('55555555-0000-4000-8000-000000000000', false),
              method(pmDefault, true),
            ],
          })
        : realisticReply(c),
    );
    const client = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      h.viaApp,
    );
    const ok = await client.callTool({
      name: 'pay_for_order_with_default',
      arguments: { orderId: ORDER },
    });
    expect(ok.isError).toBeFalsy();
    expect(h.calls[1].body).toEqual({
      orderId: ORDER,
      savedPaymentMethodId: pmDefault,
    });
    await client.close();

    const none = harness(() => Response.json({ paymentMethods: [] }));
    const c2 = await connect(
      era,
      await mintToken({ scope: ALL_SCOPES }),
      none.viaApp,
    );
    const res = await c2.callTool({
      name: 'pay_for_order_with_default',
      arguments: { orderId: ORDER },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('NO_DEFAULT_PAYMENT_METHOD');
    expect(none.calls).toHaveLength(1);
    await c2.close();
  });
});
