"use server";
// app/actions/attendance.ts — Server Actions for QR scan mutations.
// Called from scanner-client.tsx ("use client") — runs server-side so
// cookies() / authHeaders() are available in the request context.

import { base, authHeaders } from "@/lib/server-utils";
import type { ScannerRequest, ScannerResponse } from "@/lib/types";

export async function scanCheckIn(
  input: ScannerRequest
): Promise<ScannerResponse> {
  const res = await fetch(`${base()}/api/attendance/scan/check-in`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `Scan check-in failed (${res.status}).`
    );
  }
  return res.json() as Promise<ScannerResponse>;
}

export async function scanCheckInByEmail(input: {
  eventId: string;
  email: string;
  deviceId: string;
}): Promise<ScannerResponse> {
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

  const checkInRes = await fetch(`${base()}/api/attendance/scan/check-in-user`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      eventId: input.eventId,
      buyerUserId,
      deviceId: input.deviceId,
    }),
  });
  if (!checkInRes.ok) {
    const body = await checkInRes.json().catch(() => ({}));
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `Email check-in failed (${checkInRes.status}).`
    );
  }
  return checkInRes.json() as Promise<ScannerResponse>;
}
