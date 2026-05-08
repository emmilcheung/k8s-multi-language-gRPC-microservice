import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ApiError, getAttendanceSettings, serverApi } from "@/lib/api";
import type { Ticket } from "@/lib/types";
import { ScannerClient } from "@/components/scanner-client";

interface Props {
  searchParams: Promise<{ eventId?: string }>;
}

function readCurrentUserIdFromToken(token?: string): string | null {
  if (!token) return null;
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const payload = JSON.parse(json) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export default async function ScanPage({ searchParams }: Props) {
  const { eventId } = await searchParams;
  if (!eventId) {
    notFound();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }

  const currentUserId = readCurrentUserIdFromToken(token);
  if (!currentUserId) {
    redirect("/auth/signin");
  }

  const ticket = await serverApi<Ticket>(`/api/tickets/${eventId}`).catch((error) => {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  });
  if (ticket.userId !== currentUserId) {
    notFound();
  }

  const settings = await getAttendanceSettings(eventId).catch((error) => {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  });
  if (!settings.requireQrForEntry) {
    notFound();
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      <h1 className="text-2xl font-display font-extrabold tracking-tight">Scanner Console</h1>
      <p className="text-sm text-muted-foreground">
        Scan attendee QR passes with your camera. Manual token entry is available only as a fallback.
      </p>
      <ScannerClient eventId={eventId} />
    </div>
  );
}
