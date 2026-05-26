import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { DeactivateSeatingPlanDocument } from "@/lib/graphql/generated";
import { executeMutation } from "@/lib/graphql/execute";
import { authHeaders, base } from "@/lib/server-utils";
import { traceResponseHeaders } from "@/lib/tracing";
import type { SeatingPlan } from "@/lib/types";

const PLAN_STATUS_RETRY_DELAYS_MS = [100, 200, 400, 800];
const PLAN_STATUS_MUTATION_TIMEOUT_MS = 15_000;

async function waitForPlanStatus(request: NextRequest, planId: string, expectedStatus: SeatingPlan["status"]) {
  const headers = await authHeaders(request);

  for (let attempt = 0; attempt <= PLAN_STATUS_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(`${base()}/api/seating-plans/${planId}`, {
      method: "GET",
      cache: "no-store",
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to verify seating plan state (${response.status}).`);
    }

    const plan = await response.json() as SeatingPlan;
    if (plan.status === expectedStatus) {
      return;
    }

    if (attempt === PLAN_STATUS_RETRY_DELAYS_MS.length) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, PLAN_STATUS_RETRY_DELAYS_MS[attempt]));
  }

  throw new Error(`Seating plan did not reach ${expectedStatus} state in time.`);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ planId: string }> }
): Promise<NextResponse> {
  try {
    const { planId } = await context.params;

    if (!planId) {
      return NextResponse.json(
        { error: { message: "Missing planId." } },
        { status: 400, headers: traceResponseHeaders() }
      );
    }

    await executeMutation(
      DeactivateSeatingPlanDocument,
      { id: planId },
      {
        cookie: request.headers.get("cookie") ?? undefined,
        timeoutMs: PLAN_STATUS_MUTATION_TIMEOUT_MS,
      }
    );
    await waitForPlanStatus(request, planId, "inactive");

    return NextResponse.json({ ok: true }, { headers: traceResponseHeaders() });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: { message: error.message } },
        { status: error.status, headers: traceResponseHeaders() }
      );
    }

    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : "Failed to deactivate plan." } },
      { status: 500, headers: traceResponseHeaders() }
    );
  }
}
