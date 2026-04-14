#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from './client/api-client.js';
import { registerEventTools } from './tools/events.js';
import { registerSeatTools } from './tools/seats.js';
import { registerOrderTools } from './tools/orders.js';
import { registerPaymentTools } from './tools/payments.js';

const API_BASE_URL = process.env['TICKETING_API_URL'] ?? 'http://localhost:8000';

const server = new McpServer({
  name: 'ticketing',
  version: '0.1.0',
});

const apiClient = new ApiClient(API_BASE_URL);

// Register all tool groups
registerEventTools(server, apiClient);
registerSeatTools(server, apiClient);
registerOrderTools(server, apiClient);
registerPaymentTools(server, apiClient);

// Connect via stdio (standard MCP transport for Claude Code / desktop agents)
const transport = new StdioServerTransport();
await server.connect(transport);
