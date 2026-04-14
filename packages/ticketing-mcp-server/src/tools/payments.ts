import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../client/api-client.js';

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerPaymentTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    'get_payment',
    {
      description: 'Get details for a specific payment by ID',
      inputSchema: {
        paymentId: z.string().uuid().describe('The payment UUID'),
      },
    },
    async ({ paymentId }) => {
      try {
        const data = await client.get<unknown>(`/api/payments/${paymentId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'pay_for_order',
    {
      description: 'Submit payment for an existing order using a Stripe payment method token. This charges real money and cannot be undone. Obtain a Stripe token using the Stripe.js library before calling this tool.',
      inputSchema: {
        orderId: z.string().uuid().describe('The order UUID to pay for'),
        paymentToken: z.string().describe('Stripe payment method token (from Stripe.js tokenization)'),
      },
      annotations: { destructiveHint: true, title: 'Pay for Order' },
    },
    async ({ orderId, paymentToken }) => {
      try {
        const data = await client.post<unknown>('/api/payments', {
          orderId,
          token: paymentToken,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );
}
