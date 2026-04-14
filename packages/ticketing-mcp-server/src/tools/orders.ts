import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../client/api-client.js';

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerOrderTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    'list_my_orders',
    {
      description: 'List all orders for the current authenticated user',
    },
    async () => {
      try {
        const data = await client.get<unknown>('/api/orders');
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_order',
    {
      description: 'Get details for a specific order by ID',
      inputSchema: {
        orderId: z.string().uuid().describe('The order UUID'),
      },
    },
    async ({ orderId }) => {
      try {
        const data = await client.get<unknown>(`/api/orders/${orderId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'create_order',
    {
      description: 'Purchase general admission tickets for an event. Reserves quota immediately. Requires payment to complete.',
      inputSchema: {
        ticketId: z.string().uuid().describe('The ticket/event ID'),
        quantity: z.number().int().min(1).max(10).describe('Number of tickets to purchase'),
      },
      annotations: { destructiveHint: true, title: 'Create Order' },
    },
    async ({ ticketId, quantity }) => {
      try {
        const data = await client.post<unknown>('/api/orders', { ticketId, quantity });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'create_seated_order',
    {
      description: 'Reserve specific seats (manual) or auto-assign seats from a section for a seated event. Requires payment to complete.',
      inputSchema: {
        ticketId: z.string().uuid().describe('The ticket/event ID'),
        seatIds: z.array(z.string().uuid()).optional().describe('Specific seat IDs for manual selection'),
        sectionId: z.string().uuid().optional().describe('Section ID for auto-assign mode'),
        quantity: z.number().int().min(1).max(10).optional().describe('Number of seats for auto-assign'),
      },
      annotations: { destructiveHint: true, title: 'Create Seated Order' },
    },
    async ({ ticketId, seatIds, sectionId, quantity }) => {
      try {
        const body: Record<string, unknown> = { ticketId };
        if (seatIds && seatIds.length > 0) {
          body.seatIds = seatIds;
        } else {
          body.sectionId = sectionId;
          body.quantity = quantity;
        }
        const data = await client.post<unknown>('/api/orders/seated', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'cancel_order',
    {
      description: 'Cancel an existing order. The order must be in a cancellable state. Refund policy applies.',
      inputSchema: {
        orderId: z.string().uuid().describe('The order UUID to cancel'),
      },
      annotations: { destructiveHint: true, title: 'Cancel Order' },
    },
    async ({ orderId }) => {
      try {
        const data = await client.delete<unknown>(`/api/orders/${orderId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );
}
