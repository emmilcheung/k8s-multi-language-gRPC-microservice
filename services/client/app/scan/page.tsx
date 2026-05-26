import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { executeQuery } from "@/lib/graphql/execute";
import { AttendancePolicyDocument, TicketDetailDocument } from "@/lib/graphql/generated";
import { readCurrentUserIdFromToken } from "@/lib/server-utils";
import { ScannerClient } from "@/components/scanner-client";

interface Props {
  searchParams: Promise<{ eventId?: string }>;
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

  const cookie = cookieStore.toString();

  const [ticketData, policyData] = await Promise.all([
    executeQuery(TicketDetailDocument, { id: eventId }, { cookie }).catch(() => null),
    executeQuery(AttendancePolicyDocument, { eventId }, { cookie }).catch(() => null),
  ]);

  if (!ticketData?.ticket) {
    notFound();
  }
  if (ticketData.ticket.userId !== currentUserId) {
    notFound();
  }
  if (!policyData?.attendancePolicy?.requireQrForEntry) {
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
