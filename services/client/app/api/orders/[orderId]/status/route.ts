import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { OrderDetailDocument } from "@/lib/graphql/generated";
import { executeQuery } from "@/lib/graphql/execute";
import { coerceOrderStatus } from "@/lib/order-status";
import { traceResponseHeaders } from "@/lib/tracing";

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

    const data = await executeQuery(
      OrderDetailDocument,
      { id: orderId },
      { cookie: request.headers.get("cookie") ?? undefined },
    );
    const order = data.order
      ? {
          id: data.order.id,
          userId: data.order.userId,
          status: coerceOrderStatus(data.order.status),
          expiresAt: data.order.expiresAt ?? "",
          ticket: {
            id: data.order.ticket.id,
            title: data.order.ticket.title,
            price: data.order.ticket.price,
          },
          quantity: data.order.quantity,
          version: 0,
        }
      : null;

    return NextResponse.json(
      { order },
      { status: 200, headers: traceResponseHeaders() }
    );
  } catch (error) {
    if (error instanceof ApiError) {
      const body =
        error.body && typeof error.body === "object" && "error" in error.body
          ? (error.body as { error: unknown })
          : { error: { code: "ORDER_STATUS_FAILED", message: error.message } };
      return NextResponse.json(body, {
        status: error.status,
        headers: traceResponseHeaders(),
      });
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Order status fetch error:", errorMessage);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to fetch order status." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}
