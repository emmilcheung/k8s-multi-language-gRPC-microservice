import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as ClientV2,
  StreamableHTTPClientTransport as TransportV2,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { TOOL_SCOPES } from './scopes.ts';
import { mintToken, stubJwks, testConfig } from './testkit.ts';

const app = createApp({ config: testConfig, jwks: stubJwks });
const url = new URL(testConfig.MCP_RESOURCE);

// Routes the client's HTTP straight into the app: no socket, real protocol.
const inProcessFetch = (input: string | URL, init?: RequestInit) =>
  app(new Request(input, init));

describe('one endpoint serves both protocol eras', () => {
  it('a v2 client with versionNegotiation auto lists the tool (2026-07-28 era)', async () => {
    const token = await mintToken();
    const client = new ClientV2(
      { name: 'v2-auto', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new TransportV2(url, {
        fetch: inProcessFetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOL_SCOPES));
    await client.close();
  });

  it('a v1.29 client still lists the tool (Claude Code / connectors on 2025-11-25)', async () => {
    const token = await mintToken();
    const client = new ClientV1({ name: 'v1', version: '0' });
    await client.connect(
      new TransportV1(url, {
        fetch: inProcessFetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOL_SCOPES));
    await client.close();
  });
});
