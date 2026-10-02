import { McpServer } from '@modelcontextprotocol/server';

/** Builds a fresh server per request (stateless); real tools land in WS-J. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ticketing-mcp', version: '0.0.1' });
  server.registerTool(
    'ping',
    {
      description: 'Health probe tool: returns "pong".',
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );
  return server;
}
