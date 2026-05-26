"use server";
// app/actions/attendance.ts — Server Actions for QR scan mutations.
// Called from scanner-client.tsx ("use client") — runs server-side so
// cookies() / authHeaders() are available in the request context.

import type { ScannerRequest, ScannerResponse, ScannerResultClass } from "@/lib/types";
import { executeMutation, executeQuery } from "@/lib/graphql/execute";
import {
  ValidateScanDocument,
  RecordCheckinDocument,
  RecordCheckinByUserIdDocument,
  UserLookupDocument,
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
  const lookupData = await executeQuery(UserLookupDocument, { email: input.email });
  const buyerUserId = lookupData.userLookup?.id;
  if (!buyerUserId) {
    throw new Error("Buyer account not found for the provided email.");
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
