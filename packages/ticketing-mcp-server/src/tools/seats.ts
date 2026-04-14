import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../client/api-client.js';

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerSeatTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    'view_seat_availability',
    {
      description: 'View available seats for a seated event, including section layout and pricing',
      inputSchema: {
        seatingPlanId: z.string().uuid().describe('The seating plan ID (found in event details)'),
      },
    },
    async ({ seatingPlanId }) => {
      try {
        const data = await client.get<unknown>(`/api/seating-plans/${seatingPlanId}/availability`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );
}
