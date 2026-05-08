"use server";
// app/actions/attendance.ts — Server Actions for QR scan mutations.
// Called from scanner-client.tsx ("use client") — runs server-side so
// cookies() / authHeaders() are available in the request context.

import { base, authHeaders } from "@/lib/server-utils";
import type { ScannerRequest, ScannerResponse } from "@/lib/types";

export async function scanValidate(
  input: ScannerRequest
): Promise<ScannerResponse> {
  const res = await fetch(`${base()}/api/attendance/scan/validate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `Scan validate failed (${res.status}).`
    );
  }
  return res.json() as Promise<ScannerResponse>;
}

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
