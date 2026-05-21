import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { base } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";

interface SubmitPaymentRequest {
  orderId: string;
  /** Stripe PM token — used when paying with a new card */
  paymentMethodId?: string;
  /** Stored saved payment method ID — used when paying with a saved card */
  savedPaymentMethodId?: string;
}

async function submitPaymentViaRest(
  body: SubmitPaymentRequest,
  cookieHeader: string | undefined,
): Promise<Response> {
  return fetch(`${base()}/api/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(
      body.savedPaymentMethodId
        ? { orderId: body.orderId, savedPaymentMethodId: body.savedPaymentMethodId }
        : { orderId: body.orderId, token: body.paymentMethodId }
    ),
  });
}

/**
 * POST /api/submit-payment
 * Accepts a real Stripe paymentMethodId from the client and submits it to the backend payment service.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const requestBody = (await request.json()) as SubmitPaymentRequest;
    const { orderId, paymentMethodId, savedPaymentMethodId } = requestBody;
    const cookieHeader = request.headers.get("cookie") ?? undefined;

    // Validate input — must have orderId and exactly one payment identifier
    if (!orderId || (!paymentMethodId && !savedPaymentMethodId)) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "Missing required fields." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    const response = await submitPaymentViaRest(requestBody, cookieHeader);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return NextResponse.json(body, {
        status: response.status,
        headers: traceResponseHeaders(),
      });
    }

    revalidatePath(`/orders/${orderId}`);

    return NextResponse.json(body, { status: response.status, headers: traceResponseHeaders() });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Payment submission error:", errorMessage);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Payment submission failed." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}
