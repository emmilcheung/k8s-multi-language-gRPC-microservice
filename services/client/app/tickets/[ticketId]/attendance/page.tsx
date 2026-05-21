import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AttendanceSettingsForm } from "@/components/attendance-settings-form";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { executeQuery } from "@/lib/graphql/execute";
import { AttendancePageDocument } from "@/lib/graphql/generated";
import { serverApi } from "@/lib/api";
import { readCurrentUserIdFromToken } from "@/lib/server-utils";
import type { UserLookupResponse } from "@/lib/types";
import type { AttendanceCheckInItem } from "@/lib/types";

interface Props {
  params: Promise<{ ticketId: string }>;
}

export default async function AttendanceSettingsPage({ params }: Props) {
  const { ticketId } = await params;

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }
  const currentUserId = readCurrentUserIdFromToken(token);
  if (!currentUserId) {
    redirect("/auth/signin");
  }

  const data = await executeQuery(
    AttendancePageDocument,
    { id: ticketId },
    { cookie: cookieStore.toString() }
  ).catch(() => notFound());

  const ticket = data.ticket;
  if (!ticket || ticket.userId !== currentUserId) {
    notFound();
  }

  const settings = data.attendancePolicy
    ? {
        eventId: data.attendancePolicy.eventId,
        requireQrForEntry: data.attendancePolicy.requireQrForEntry,
        allowManualOverride: data.attendancePolicy.allowManualOverride,
      }
    : null;
  if (!settings) {
    notFound();
  }

  const summary = data.attendanceSummary
    ? {
        eventId: data.attendanceSummary.eventId,
        totalAdmitted: data.attendanceSummary.totalAdmitted,
        totalDenied: data.attendanceSummary.totalDenied,
        totalCheckedIn: data.attendanceSummary.totalCheckedIn,
      }
    : null;

  const checkIns: AttendanceCheckInItem[] = (data.eventCheckins ?? []).map((checkIn) => ({
    credentialId: checkIn.id,
    ticketId: checkIn.ticketId,
    orderId: checkIn.orderId,
    eventId: checkIn.eventId,
    status: "USED",
    buyerUserId: checkIn.userId ?? undefined,
    checkedInAt: checkIn.checkedInAt,
  }));

  const buyerUserIDs = Array.from(
    new Set(checkIns.map((item) => item.buyerUserId).filter((value): value is string => Boolean(value)))
  );
  const buyerEmailsByUserID = new Map<string, string>();
  await Promise.all(
    buyerUserIDs.map(async (buyerUserID) => {
      try {
        const lookup = await serverApi<UserLookupResponse>(`/api/users/lookup?id=${encodeURIComponent(buyerUserID)}`);
        buyerEmailsByUserID.set(buyerUserID, lookup.user.email);
      } catch {
        // Best-effort enrichment: keep user ID fallback in the UI.
      }
    })
  );

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <Link
        href={`/tickets/${ticketId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to ticket
      </Link>

      <h1 className="text-2xl font-display font-extrabold tracking-tight">Attendance Settings</h1>

      <AttendanceSettingsForm
        eventId={ticket.id}
        initialSettings={settings}
        summary={summary}
        checkIns={checkIns}
        buyerEmailsByUserID={Object.fromEntries(buyerEmailsByUserID.entries())}
        locked={(ticket.sold ?? 0) > 0}
      />
    </div>
  );
}
