import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { authHeaders, base } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";

interface RegisterPaymentMethodRequest {
  paymentMethodId: string;
  setAsDefault?: boolean;
  consentAccepted: boolean;
  consentVersion: string;
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
 * POST /api/payment-methods/register
 * Registers a tokenized payment method id in payment-service.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as RegisterPaymentMethodRequest;
    const { paymentMethodId, setAsDefault, consentAccepted, consentVersion } = body;

    if (!paymentMethodId || typeof paymentMethodId !== "string") {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "paymentMethodId is required." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    if (consentAccepted !== true || typeof consentVersion !== "string" || !consentVersion.trim()) {
      return NextResponse.json(
        {
          error: {
            code: "CONSENT_REQUIRED",
            message: "Explicit card-on-file consent is required.",
          },
        },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    const upstreamHeaders = new Headers(await authHeaders(request));
    upstreamHeaders.set("x-consent-source", "settings-ui");
    const userAgent = request.headers.get("user-agent");
    if (userAgent) {
      upstreamHeaders.set("user-agent", userAgent);
    }
    const forwardedFor = request.headers.get("x-forwarded-for");
    if (forwardedFor) {
      upstreamHeaders.set("x-forwarded-for", forwardedFor);
    }

    const response = await fetch(`${base()}/api/payments/methods/register`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({
        providerPaymentMethodId: paymentMethodId,
        setAsDefault: Boolean(setAsDefault),
        consentAccepted,
        consentVersion: consentVersion.trim(),
      }),
    });

    if (!response.ok) {
      const responseBody = (await readJsonBody(response)) as { error?: unknown } | null;
      return NextResponse.json(
        { error: responseBody?.error ?? { message: "Failed to register payment method." } },
        { status: response.status, headers: traceResponseHeaders() }
      );
    }

    const responseBody = await readJsonBody(response);
    revalidatePath("/settings");

    return NextResponse.json(responseBody ?? {}, {
      status: response.status,
      headers: traceResponseHeaders(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Payment method registration error:", message);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Payment method registration failed." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}