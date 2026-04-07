import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";

interface SubmitPaymentRequest {
  orderId: string;
  amount: number;
  paymentMethodId: string;
}

/**
 * POST /api/submit-payment
 * Accepts a real Stripe paymentMethodId from the client and submits it to the backend payment service.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as SubmitPaymentRequest;
    const { orderId, amount, paymentMethodId } = body;

    // Validate input
    if (!orderId || !amount || !paymentMethodId) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "Missing required fields." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    // Call the backend payment service with the real paymentMethodId
    const res = await fetch(`${base()}/api/payments`, {
      method: "POST",
      headers: await authHeaders(request),
      body: JSON.stringify({
        orderId,
        amount,
        token: paymentMethodId, // Backend expects 'token' field with paymentMethodId
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: body?.error ?? { message: "Payment processing failed." } },
        { status: res.status, headers: traceResponseHeaders() }
      );
    }

    const paymentResponse = await res.json();

    // Revalidate the order page to reflect payment status
    revalidatePath(`/orders/${orderId}`);

    return NextResponse.json(paymentResponse, {
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
