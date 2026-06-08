import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, QrCode, Settings2, Users } from "lucide-react";
import { AttendanceSettingsForm } from "@/components/attendance-settings-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { executeQuery } from "@/lib/graphql/execute";
import { AttendancePageDocument, TicketDetailDocument, UserLookupDocument } from "@/lib/graphql/generated";
import { readCurrentUserIdFromToken } from "@/lib/server-utils";
import type { AttendanceCheckInItem } from "@/lib/types";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function OrganizerAttendancePage({ params }: Props) {
  const { id } = await params;

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
  const [attendanceData, ticketDetailData] = await Promise.all([
    executeQuery(AttendancePageDocument, { id }, { cookie }).catch(() => notFound()),
    executeQuery(TicketDetailDocument, { id }, { cookie }).catch(() => null),
  ]);

  const ticket = attendanceData.ticket;
  if (!ticket || ticket.userId !== currentUserId) {
    notFound();
  }

  const settings = attendanceData.attendancePolicy
    ? {
        eventId: attendanceData.attendancePolicy.eventId,
        requireQrForEntry: attendanceData.attendancePolicy.requireQrForEntry,
        allowManualOverride: attendanceData.attendancePolicy.allowManualOverride,
      }
    : null;
  if (!settings) {
    notFound();
  }

  const summary = attendanceData.attendanceSummary
    ? {
        eventId: attendanceData.attendanceSummary.eventId,
        totalAdmitted: attendanceData.attendanceSummary.totalAdmitted,
        totalDenied: attendanceData.attendanceSummary.totalDenied,
        totalCheckedIn: attendanceData.attendanceSummary.totalCheckedIn,
      }
    : null;

  const checkIns: AttendanceCheckInItem[] = (attendanceData.eventCheckins ?? []).map((checkIn) => ({
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
        const lookupData = await executeQuery(
          UserLookupDocument,
          { id: buyerUserID },
          { cookie }
        );
        if (lookupData.userLookup?.email) {
          buyerEmailsByUserID.set(buyerUserID, lookupData.userLookup.email);
        }
      } catch {
        // Best-effort enrichment only.
      }
    })
  );

  const eventTitle = ticketDetailData?.ticket?.event?.title?.trim() || ticketDetailData?.ticket?.title || ticket.title;
  const venueName = ticketDetailData?.ticket?.event?.venueName?.trim() || null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 rounded-2xl border border-line bg-card px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge tone="bad" dot>
                Tonight · live
              </Badge>
            </div>
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">{eventTitle}</h1>
            <p className="text-sm text-mute">
              {venueName ? `${venueName} · ` : ""}Monitor check-ins, update policy, and launch the scanner.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/tickets/${id}`}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
            >
              <ArrowLeft className="size-3.5" />
              Back to ticket
            </Link>
            <Link
              href={`/scan?eventId=${id}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
            >
              <QrCode className="size-3.5" />
              Open scanner
            </Link>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Tickets sold</p>
              <p className="text-2xl font-semibold text-ink">{ticket.sold ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Checked in</p>
              <p className="text-2xl font-semibold text-ink">{summary?.totalAdmitted ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Denied</p>
              <p className="text-2xl font-semibold text-ink">{summary?.totalDenied ?? 0}</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-mute">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-subtle px-3 py-1.5">
            <Settings2 className="size-3.5" />
            Policy settings below
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-subtle px-3 py-1.5">
            <Users className="size-3.5" />
            {checkIns.length} recent scans loaded
          </span>
        </div>
      </header>

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
