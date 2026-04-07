import { NextResponse } from "next/server";
import { traceResponseHeaders } from "@/lib/tracing";

export async function GET() {
  return NextResponse.json({ status: "ok" }, { headers: traceResponseHeaders() });
}
