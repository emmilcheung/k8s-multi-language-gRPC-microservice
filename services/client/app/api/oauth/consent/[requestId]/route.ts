import { NextRequest, NextResponse } from "next/server";
import { authHeaders, base } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";

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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> | { requestId: string } }
): Promise<NextResponse> {
  const { requestId } = await Promise.resolve(context.params);
  const body = (await request.json()) as { approve?: boolean };

  if (typeof body.approve !== "boolean") {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "approve must be a boolean" } },
      { status: 400, headers: traceResponseHeaders() }
    );
  }

  const upstream = await fetch(`${base()}/oauth/consent/${requestId}`, {
    method: "POST",
    headers: await authHeaders(request),
    body: JSON.stringify({ approve: body.approve }),
  });

  const responseBody = await readJsonBody(upstream);

  if (!upstream.ok) {
    return NextResponse.json(
      responseBody ?? { error: { code: "REQUEST_FAILED", message: "Consent request failed." } },
      { status: upstream.status, headers: traceResponseHeaders() }
    );
  }

  return NextResponse.json(responseBody ?? {}, {
    status: upstream.status,
    headers: traceResponseHeaders(),
  });
}
