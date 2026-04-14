import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../client/api-client.js';

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerEventTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    'search_events',
    {
      description: 'Search for available events and tickets by title, availability, or pagination cursor',
      inputSchema: {
        query: z.string().optional().describe('Search term for event title'),
        available: z.boolean().default(true).describe('Only show events with available tickets'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max number of results'),
        after: z.string().optional().describe('Pagination cursor (from previous response)'),
      },
    },
    async ({ query, available, limit, after }) => {
      try {
        const params = new URLSearchParams();
        if (query) params.set('search', query);
        if (available) params.set('available', 'true');
        params.set('limit', String(limit));
        if (after) params.set('after', after);

        const data = await client.get<unknown>(`/api/tickets?${params.toString()}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_event',
    {
      description: 'Get full details for a specific event/ticket by ID, including seating plan info',
      inputSchema: {
        eventId: z.string().uuid().describe('The ticket/event UUID'),
      },
    },
    async ({ eventId }) => {
      try {
        const data = await client.get<unknown>(`/api/tickets/${eventId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );
}
