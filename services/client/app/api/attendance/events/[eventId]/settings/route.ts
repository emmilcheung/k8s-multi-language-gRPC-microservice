// app/api/attendance/events/[eventId]/settings/route.ts
// Thin Next.js proxy — forwards GET/PATCH to the attendance-service via Kong.
// Client components call /api/attendance/events/:id/settings with session cookies;
// this handler adds the Authorization header using the server-side cookie store.

import { type NextRequest, NextResponse } from "next/server";
import { authHeaders } from "@/lib/server-utils";
import { base } from "@/lib/server-utils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;
  const upstream = await fetch(
    `${base()}/api/attendance/events/${eventId}/settings`,
    { headers: await authHeaders(req) }
  );
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;
  const upstream = await fetch(
    `${base()}/api/attendance/events/${eventId}/settings`,
    {
      method: "PATCH",
      headers: await authHeaders(req),
      body: await req.text(),
    }
  );
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}
