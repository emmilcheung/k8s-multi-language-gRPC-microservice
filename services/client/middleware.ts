import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const traceparent = request.headers.get("traceparent") ?? request.headers.get("x-b3-traceid");

  if (traceparent) {
    const traceId = traceparent.includes("-") ? traceparent.split("-")[1] : traceparent;
    if (traceId) {
      response.headers.set("x-trace-id", traceId);
    }
  }

  return response;
}

export const config = {
  matcher: ["/:path*"],
};
