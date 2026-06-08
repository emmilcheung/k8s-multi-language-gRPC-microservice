import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ArrowRight, QrCode } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { executeQuery } from "@/lib/graphql/execute";
import { AttendancePageDocument, OrganizerTicketsDocument } from "@/lib/graphql/generated";
import { readCurrentUserIdFromToken } from "@/lib/server-utils";
import { cn } from "@/lib/utils";

type OrganizerEventRow = {
  id: string;
  title: string;
  venueName: string | null;
  startsAt: string;
  sold: number;
  priceDecimal: string;
  admitted: number;
  denied: number;
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const getCurrentTime = cache(() => Date.now());

function formatEventDate(startsAt: string): string {
  return new Date(startsAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function grossForRow(row: OrganizerEventRow): number {
  return Math.round(parseFloat(row.priceDecimal) * 100) * row.sold;
}

async function getOrganizerRows(cookie: string, currentUserId: string): Promise<OrganizerEventRow[]> {
  const data = await executeQuery(OrganizerTicketsDocument, {}, { cookie });
  const ownedTickets = data.tickets.filter(
    (ticket) => ticket.userId === currentUserId && ticket.event?.startsAt
  );

  const rows = await Promise.all(
    ownedTickets.map(async (ticket) => {
      const attendance = await executeQuery(AttendancePageDocument, { id: ticket.id }, { cookie });

      return {
        id: ticket.id,
        title: ticket.event?.title?.trim() || ticket.title,
        venueName: ticket.event?.venueName?.trim() || null,
        startsAt: ticket.event!.startsAt,
        sold: ticket.sold,
        priceDecimal: ticket.priceDecimal,
        admitted: attendance.attendanceSummary?.totalAdmitted ?? 0,
        denied: attendance.attendanceSummary?.totalDenied ?? 0,
      };
    })
  );

  return rows.sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
}

export default async function OrganizerPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }

  const currentUserId = readCurrentUserIdFromToken(token);
  if (!currentUserId) {
    redirect("/auth/signin");
  }

  const rows = await getOrganizerRows(cookieStore.toString(), currentUserId);
  const now = getCurrentTime();
  const activeRows = rows.filter((row) => new Date(row.startsAt).getTime() >= now);
  const grossSales = rows.reduce((sum, row) => sum + grossForRow(row), 0);
  const totalSold = rows.reduce((sum, row) => sum + row.sold, 0);
  const totalCheckedIn = rows.reduce((sum, row) => sum + row.admitted, 0);

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Organizer dashboard</CardTitle>
          <CardDescription>No owned events were found for this account yet.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/tickets/new" className={buttonVariants({ size: "sm" })}>
            Create event
          </Link>
          <Link href="/venues" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Manage venues
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Gross sales</p>
              <p className="text-2xl font-semibold text-ink">{moneyFormatter.format(grossSales / 100)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Tickets sold</p>
              <p className="text-2xl font-semibold text-ink">{totalSold}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Active events</p>
              <p className="text-2xl font-semibold text-ink">{activeRows.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-1 pt-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Checked in</p>
              <p className="text-2xl font-semibold text-ink">{totalCheckedIn}</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Active events</CardTitle>
            <CardDescription>Attendance and scanner shortcuts for your upcoming shows.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(activeRows.length > 0 ? activeRows : rows).map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-md border border-line bg-page px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="space-y-1">
                  <p className="font-semibold text-ink">{row.title}</p>
                  <p className="text-sm text-mute">
                    {formatEventDate(row.startsAt)}
                    {row.venueName ? ` · ${row.venueName}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2 text-xs text-mute">
                    <Badge tone="neutral">{row.sold} sold</Badge>
                    <Badge tone="ok">{row.admitted} admitted</Badge>
                    <Badge tone={row.denied > 0 ? "bad" : "neutral"}>{row.denied} denied</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/organizer/events/${row.id}/attendance`}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
                  >
                    Attendance monitor
                    <ArrowRight className="size-3.5" />
                  </Link>
                  <Link
                    href={`/scan?eventId=${row.id}`}
                    className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
                  >
                    <QrCode className="size-3.5" />
                    Open scanner
                  </Link>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live activity</CardTitle>
          <CardDescription>Waiting on a dedicated organizer activity query or subscription.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Badge tone="accent">Live activity coming soon</Badge>
          <p className="text-sm text-mute">
            Phase 6 ships the dashboard without fabricated activity rows. See the redesign API gaps doc for the required backend additions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
