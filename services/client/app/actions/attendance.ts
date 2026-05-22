"use server";
// app/actions/attendance.ts — Server Actions for QR scan mutations.
// Called from scanner-client.tsx ("use client") — runs server-side so
// cookies() / authHeaders() are available in the request context.

import { base, authHeaders } from "@/lib/server-utils";
import type { ScannerRequest, ScannerResponse, ScannerResultClass } from "@/lib/types";
import { executeMutation } from "@/lib/graphql/execute";
import {
  ValidateScanDocument,
  RecordCheckinDocument,
  RecordCheckinByUserIdDocument,
} from "@/lib/graphql/generated";

export async function scanCheckIn(
  input: ScannerRequest
): Promise<ScannerResponse> {
  // Step 1: validate the QR token to get ticketId and confirm it is unused.
  const { validateScan: scan } = await executeMutation(ValidateScanDocument, {
    token: input.token,
  });

  if (!scan.valid) {
    return {
      result: (scan.reason ?? "invalid_signature") as ScannerResultClass,
      eventId: scan.eventId ?? undefined,
    };
  }

  if (!scan.ticketId) {
    return { result: "invalid_signature" };
  }

  // Step 2: record the check-in with QR source.
  const { recordCheckin: checkin } = await executeMutation(RecordCheckinDocument, {
    input: { ticketId: scan.ticketId, source: "QR_SCAN" },
  });

  return {
    result: "valid",
    credentialId: checkin.id,
    eventId: checkin.eventId,
  };
}

export async function scanCheckInByEmail(input: {
  eventId: string;
  email: string;
  deviceId: string;
}): Promise<ScannerResponse> {
  // Users/lookup stays REST — no GraphQL equivalent.
  const lookupRes = await fetch(
    `${base()}/api/users/lookup?email=${encodeURIComponent(input.email)}`,
    {
      method: "GET",
      headers: await authHeaders(),
      cache: "no-store",
    }
  );
  if (!lookupRes.ok) {
    const body = await lookupRes.json().catch(() => ({}));
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        "Buyer account not found for the provided email."
    );
  }
  const lookupBody = (await lookupRes.json()) as { user?: { id?: string } };
  const buyerUserId = lookupBody.user?.id;
  if (!buyerUserId) {
    throw new Error("Buyer account lookup returned an invalid response.");
  }

  const { recordCheckinByUserId: checkin } = await executeMutation(
    RecordCheckinByUserIdDocument,
    { input: { eventId: input.eventId, userId: buyerUserId } }
  );

  return {
    result: "valid",
    eventId: checkin.eventId,
  };
}
