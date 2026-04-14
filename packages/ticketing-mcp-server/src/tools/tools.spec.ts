import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventTools } from './events.js';
import { registerSeatTools } from './seats.js';
import { registerOrderTools } from './orders.js';
import { registerPaymentTools } from './payments.js';
import type { ApiClient } from '../client/api-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type RegisteredEntry = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
};

function makeMockServer() {
  const tools: RegisteredEntry[] = [];
  const server = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>, handler: RegisteredEntry['handler']) => {
      tools.push({ name, config, handler });
    }),
    _tools: tools,
  };
  return server as unknown as McpServer & { _tools: RegisteredEntry[] };
}

function makeApiClient(data: unknown = { id: 'test' }): ApiClient {
  return {
    get: vi.fn().mockResolvedValue(data),
    post: vi.fn().mockResolvedValue(data),
    delete: vi.fn().mockResolvedValue(data),
  } as unknown as ApiClient;
}

function getHandler(server: ReturnType<typeof makeMockServer>, name: string) {
  const entry = server._tools.find((t) => t.name === name);
  if (!entry) throw new Error(`Tool "${name}" not registered`);
  return entry.handler;
}

// ── Event tools ───────────────────────────────────────────────────────────────

describe('registerEventTools', () => {
  let server: ReturnType<typeof makeMockServer>;
  let client: ApiClient;

  beforeEach(() => {
    server = makeMockServer();
    client = makeApiClient();
    registerEventTools(server, client);
  });

  it('registers search_events and get_event', () => {
    const names = server._tools.map((t) => t.name);
    expect(names).toContain('search_events');
    expect(names).toContain('get_event');
  });

  it('search_events returns text content on success', async () => {
    const handler = getHandler(server, 'search_events');
    const result = await handler({ query: 'rock', available: true, limit: 10 }) as { content: { type: string; text: string }[] };
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('"id"');
  });

  it('search_events returns isError:true on API failure', async () => {
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    const handler = getHandler(server, 'search_events');
    const result = await handler({ available: true, limit: 20 }) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('network error');
  });

  it('get_event returns isError:true on API failure', async () => {
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));
    const handler = getHandler(server, 'get_event');
    const result = await handler({ eventId: '00000000-0000-0000-0000-000000000001' }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// ── Seat tools ────────────────────────────────────────────────────────────────

describe('registerSeatTools', () => {
  let server: ReturnType<typeof makeMockServer>;
  let client: ApiClient;

  beforeEach(() => {
    server = makeMockServer();
    client = makeApiClient({ sections: [] });
    registerSeatTools(server, client);
  });

  it('registers view_seat_availability', () => {
    expect(server._tools.map((t) => t.name)).toContain('view_seat_availability');
  });

  it('returns text content on success', async () => {
    const handler = getHandler(server, 'view_seat_availability');
    const result = await handler({ seatingPlanId: '00000000-0000-0000-0000-000000000001' }) as { content: { type: string }[] };
    expect(result.content[0]?.type).toBe('text');
  });

  it('returns isError:true on failure', async () => {
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unavailable'));
    const handler = getHandler(server, 'view_seat_availability');
    const result = await handler({ seatingPlanId: '00000000-0000-0000-0000-000000000001' }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// ── Order tools ───────────────────────────────────────────────────────────────

describe('registerOrderTools', () => {
  let server: ReturnType<typeof makeMockServer>;
  let client: ApiClient;

  beforeEach(() => {
    server = makeMockServer();
    client = makeApiClient({ orderId: 'o1', status: 'created' });
    registerOrderTools(server, client);
  });

  it('registers all 5 order tools', () => {
    const names = server._tools.map((t) => t.name);
    expect(names).toContain('list_my_orders');
    expect(names).toContain('get_order');
    expect(names).toContain('create_order');
    expect(names).toContain('create_seated_order');
    expect(names).toContain('cancel_order');
  });

  it('destructive tools have destructiveHint annotation', () => {
    for (const name of ['create_order', 'create_seated_order', 'cancel_order']) {
      const entry = server._tools.find((t) => t.name === name);
      expect((entry?.config as { annotations?: { destructiveHint?: boolean } })?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it('list_my_orders returns text content', async () => {
    const handler = getHandler(server, 'list_my_orders');
    const result = await handler({}) as { content: { type: string }[] };
    expect(result.content[0]?.type).toBe('text');
  });

  it('create_order returns isError:true on failure', async () => {
    (client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('quota exceeded'));
    const handler = getHandler(server, 'create_order');
    const result = await handler({ ticketId: '00000000-0000-0000-0000-000000000001', quantity: 2 }) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('quota exceeded');
  });

  it('create_seated_order uses seatIds when provided', async () => {
    const handler = getHandler(server, 'create_seated_order');
    await handler({ ticketId: '00000000-0000-0000-0000-000000000001', seatIds: ['00000000-0000-0000-0000-000000000002'] });
    expect(client.post).toHaveBeenCalledWith(
      '/api/orders/seated',
      expect.objectContaining({ seatIds: ['00000000-0000-0000-0000-000000000002'] }),
    );
  });

  it('create_seated_order uses sectionId+quantity when no seatIds', async () => {
    const handler = getHandler(server, 'create_seated_order');
    await handler({ ticketId: '00000000-0000-0000-0000-000000000001', sectionId: '00000000-0000-0000-0000-000000000003', quantity: 2 });
    expect(client.post).toHaveBeenCalledWith(
      '/api/orders/seated',
      expect.objectContaining({ sectionId: '00000000-0000-0000-0000-000000000003', quantity: 2 }),
    );
  });
});

// ── Payment tools ─────────────────────────────────────────────────────────────

describe('registerPaymentTools', () => {
  let server: ReturnType<typeof makeMockServer>;
  let client: ApiClient;

  beforeEach(() => {
    server = makeMockServer();
    client = makeApiClient({ paymentId: 'p1', status: 'completed' });
    registerPaymentTools(server, client);
  });

  it('registers get_payment and pay_for_order', () => {
    const names = server._tools.map((t) => t.name);
    expect(names).toContain('get_payment');
    expect(names).toContain('pay_for_order');
  });

  it('pay_for_order has destructiveHint annotation', () => {
    const entry = server._tools.find((t) => t.name === 'pay_for_order');
    expect((entry?.config as { annotations?: { destructiveHint?: boolean } })?.annotations?.destructiveHint).toBe(true);
  });

  it('pay_for_order posts with orderId and token', async () => {
    const handler = getHandler(server, 'pay_for_order');
    await handler({ orderId: '00000000-0000-0000-0000-000000000001', paymentToken: 'tok_test' });
    expect(client.post).toHaveBeenCalledWith('/api/payments', { orderId: '00000000-0000-0000-0000-000000000001', token: 'tok_test' });
  });

  it('pay_for_order returns isError:true on failure', async () => {
    (client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('card declined'));
    const handler = getHandler(server, 'pay_for_order');
    const result = await handler({ orderId: '00000000-0000-0000-0000-000000000001', paymentToken: 'tok_test' }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});
