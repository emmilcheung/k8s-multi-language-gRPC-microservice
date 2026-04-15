import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";

interface SubmitPaymentRequest {
  orderId: string;
  /** Stripe PM token — used when paying with a new card */
  paymentMethodId?: string;
  /** Stored saved payment method ID — used when paying with a saved card */
  savedPaymentMethodId?: string;
}

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
 * POST /api/submit-payment
 * Accepts a real Stripe paymentMethodId from the client and submits it to the backend payment service.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as SubmitPaymentRequest;
    const { orderId, paymentMethodId, savedPaymentMethodId } = body;

    // Validate input — must have orderId and exactly one payment identifier
    if (!orderId || (!paymentMethodId && !savedPaymentMethodId)) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "Missing required fields." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    // Build payment-service payload — use saved method ID or Stripe token
    const paymentPayload = savedPaymentMethodId
      ? { orderId, savedPaymentMethodId }
      : { orderId, token: paymentMethodId };

    // Call the backend payment service
    const res = await fetch(`${base()}/api/payments`, {
      method: "POST",
      headers: await authHeaders(request),
      body: JSON.stringify(paymentPayload),
    });

    if (!res.ok) {
      const body = (await readJsonBody(res)) as { error?: unknown } | null;
      return NextResponse.json(
        { error: body?.error ?? { message: "Payment processing failed." } },
        { status: res.status, headers: traceResponseHeaders() }
      );
    }

    const paymentResponse = await readJsonBody(res);

    // Revalidate the order page to reflect payment status
    revalidatePath(`/orders/${orderId}`);

    return NextResponse.json(paymentResponse ?? {}, {
      status: 201,
      headers: traceResponseHeaders(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Payment submission error:", errorMessage);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Payment submission failed." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}
