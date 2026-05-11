import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AttendanceSettingsForm } from "@/components/attendance-settings-form";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import {
  ApiError,
  getAttendanceCheckIns,
  getAttendanceSettings,
  getAttendanceSummary,
  lookupUser,
  serverApi,
} from "@/lib/api";
import type { Ticket } from "@/lib/types";

interface Props {
  params: Promise<{ ticketId: string }>;
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

export default async function AttendanceSettingsPage({ params }: Props) {
  const { ticketId } = await params;

  const ticket = await serverApi<Ticket>(`/api/tickets/${ticketId}`).catch((error) => {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  });

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const currentUserId = readCurrentUserIdFromToken(token);
  if (!currentUserId || ticket.userId !== currentUserId) {
    notFound();
  }

  const [settings, summary, checkIns] = await Promise.all([
    getAttendanceSettings(ticket.id).catch((error) => {
      if (error instanceof ApiError && error.status === 404) {
        notFound();
      }
      throw error;
    }),
    getAttendanceSummary(ticket.id).catch(() => null),
    getAttendanceCheckIns(ticket.id).catch(() => ({ eventId: ticket.id, items: [] })),
  ]);

  const buyerUserIDs = Array.from(
    new Set(checkIns.items.map((item) => item.buyerUserId).filter((value): value is string => Boolean(value)))
  );
  const buyerEmailsByUserID = new Map<string, string>();
  await Promise.all(
    buyerUserIDs.map(async (buyerUserID) => {
      try {
        const lookup = await lookupUser({ id: buyerUserID });
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
        checkIns={checkIns.items}
        buyerEmailsByUserID={Object.fromEntries(buyerEmailsByUserID.entries())}
        locked={(ticket.sold ?? 0) > 0}
      />
    </div>
  );
}
