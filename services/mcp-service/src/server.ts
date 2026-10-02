import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from './tools.ts';
import type { Upstream } from './upstream.ts';

interface ServerDeps {
  upstream: Upstream;
  publicWebUrl: string;
}

/** Builds a fresh server per request (stateless). */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'ticketing-mcp', version: '0.0.1' });
  registerTools(server, deps);
  return server;
}
