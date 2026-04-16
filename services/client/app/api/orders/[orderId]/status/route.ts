import { NextRequest, NextResponse } from "next/server";
import { base, authHeaders } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";
import type { Order } from "@/lib/types";

async function readJsonBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

/**
 * GET /api/orders/[orderId]/status
 * Lightweight endpoint to fetch current order status from the backend.
 * Used by the payment form to poll for order completion after payment submission.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orderId: string }> }
): Promise<NextResponse> {
  try {
    const { orderId } = await context.params;

    if (!orderId) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "Missing orderId." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    const res = await fetch(`${base()}/api/orders/${orderId}`, {
      method: "GET",
      headers: await authHeaders(request),
    });

    if (!res.ok) {
      const body = (await readJsonBody(res)) as { error?: unknown } | null;
      return NextResponse.json(
        { error: body?.error ?? { message: "Failed to fetch order status." } },
        { status: res.status, headers: traceResponseHeaders() }
      );
    }

    const order = (await readJsonBody(res)) as Order | null;

    return NextResponse.json(
      { order },
      { status: 200, headers: traceResponseHeaders() }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Order status fetch error:", errorMessage);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to fetch order status." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}
