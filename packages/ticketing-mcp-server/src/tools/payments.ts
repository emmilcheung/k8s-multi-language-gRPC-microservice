import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../client/api-client.js';

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SavedPaymentMethod {
  id: string;
  brand?: string;
  label?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  isDefault?: boolean;
}

interface PaymentMethodsResponse {
  paymentMethods: SavedPaymentMethod[];
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
    'list_payment_methods',
    {
      description: 'List the saved payment methods for the authenticated user. Returns card brand, last 4 digits, expiry, and which one is set as the default. Use this before paying to check if the user has a default payment method that can be used without entering card details.',
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.get<PaymentMethodsResponse>('/api/payments/methods');
        const methods = data.paymentMethods ?? [];
        if (methods.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No saved payment methods found.' }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'pay_for_order',
    {
      description: 'Submit payment for an existing order. Provide either savedPaymentMethodId (from list_payment_methods) to charge a stored card, or paymentToken (a Stripe payment method token from Stripe.js) to charge a new card. Prefer savedPaymentMethodId when the user has a default payment method — this avoids handling raw card data. This charges real money and cannot be undone.',
      inputSchema: {
        orderId: z.string().uuid().describe('The order UUID to pay for'),
        savedPaymentMethodId: z.string().uuid().optional().describe('ID of a saved payment method returned by list_payment_methods. Use this to pay with a stored card without handling card details.'),
        paymentToken: z.string().optional().describe('Stripe payment method token (from Stripe.js tokenization). Only needed when the user does not have a saved payment method.'),
      },
      annotations: { destructiveHint: true, title: 'Pay for Order' },
    },
    async ({ orderId, savedPaymentMethodId, paymentToken }) => {
      if (!savedPaymentMethodId && !paymentToken) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Provide either savedPaymentMethodId or paymentToken.' }],
          isError: true,
        };
      }

      try {
        const payload = savedPaymentMethodId
          ? { orderId, savedPaymentMethodId }
          : { orderId, token: paymentToken };

        const data = await client.post<unknown>('/api/payments', payload);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'pay_for_order_with_default',
    {
      description: 'Pay for an order automatically using the user\'s default saved payment method. Fetches the default method and charges it in one step — no card details required. Returns an error if no default payment method is set. This charges real money and cannot be undone.',
      inputSchema: {
        orderId: z.string().uuid().describe('The order UUID to pay for'),
      },
      annotations: { destructiveHint: true, title: 'Pay with Default Method' },
    },
    async ({ orderId }) => {
      try {
        // Fetch the user's saved payment methods to find the default
        const methodsData = await client.get<PaymentMethodsResponse>('/api/payments/methods');
        const methods = methodsData.paymentMethods ?? [];
        const defaultMethod = methods.find((m) => m.isDefault);

        if (!defaultMethod) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No default payment method found. Ask the user to set a default payment method in Settings, or use pay_for_order with a savedPaymentMethodId from list_payment_methods.',
            }],
            isError: true,
          };
        }

        const data = await client.post<unknown>('/api/payments', {
          orderId,
          savedPaymentMethodId: defaultMethod.id,
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Payment submitted using ${defaultMethod.label ?? `${defaultMethod.brand} ••••${defaultMethod.last4}`} (default).\n\n${JSON.stringify(data, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${toError(err)}` }], isError: true };
      }
    },
  );
}
