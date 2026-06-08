import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import QRCode from "qrcode";
import { executeQuery } from "@/lib/graphql/execute";
import {
  AdmissionPassDocument,
  TicketDetailDocument,
} from "@/lib/graphql/generated";
import { serverApi } from "@/lib/api";
import { PassCard } from "@/components/system";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { AdmissionPass, Order } from "@/lib/types";
import { PassWakeLock } from "@/components/pass-wake-lock";

interface Props {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ orderId?: string }>;
}

function formatEventDateLabel(value?: string) {
  if (!value) return "Event date TBD";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value?: string) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function statusTone(status: AdmissionPass["status"]) {
  switch (status) {
    case "ISSUED":
      return "ok";
    case "USED":
      return "warn";
    case "REVOKED":
    case "EXPIRED":
      return "bad";
  }
}

export default async function AdmissionPage({ params, searchParams }: Props) {
  const { ticketId } = await params;
  const { orderId } = await searchParams;

  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const data = await executeQuery(
    AdmissionPassDocument,
    { ticketId, orderId: orderId ?? null },
    { cookie: cookieStore.toString() }
  ).catch(() => notFound());

  if (!data.admissionPass) {
    notFound();
  }

  const raw = data.admissionPass;
  const pass: AdmissionPass = {
    id: raw.id,
    ticketId: raw.ticketId,
    orderId: raw.orderId,
    eventId: raw.eventId,
    status: raw.status as "ISSUED" | "USED" | "REVOKED" | "EXPIRED",
    transferState: "NONE",
    transferredTo: undefined,
    transferredAt: undefined,
    issuedAt: raw.issuedAt,
    usedAt: raw.usedAt ?? undefined,
    qrToken: raw.qrToken ?? undefined,
  };

  const [ticketData, order] = await Promise.all([
    executeQuery(TicketDetailDocument, { id: ticketId }, { cookie: cookieStore.toString() }).catch(() => null),
    serverApi<Order>(`/api/orders/${orderId ?? pass.orderId}`).catch(() => null),
  ]);

  const ticket = ticketData?.ticket;
  const orderSeats = order?.seats ?? [];
  const passCount = Math.max(orderSeats.length || order?.quantity || 1, 1);
  const eventTitle = ticket?.event?.title ?? ticket?.title ?? "Admission Pass";
  const venueName = ticket?.event?.venueName ?? "Venue details coming soon";
  const eventDescription = ticket?.event?.description ?? "Mobile entry";
  const eventDateLabel = formatEventDateLabel(ticket?.event?.startsAt);
  const orderLabel = (orderId ?? pass.orderId).slice(0, 8).toUpperCase();
  const primarySeatLabel = orderSeats[0]?.seatLabel;
  const [primaryRowLabel = "—", primarySeatNumber = "—"] = primarySeatLabel?.split("-") ?? [];
  const groupPasses = orderSeats.length
    ? orderSeats.map((seat, index) => ({
        id: seat.seatId,
        label: seat.seatLabel,
        summary: index === 0 ? "This pass" : "Additional pass in this order",
        showStatus: index === 0,
      }))
    : Array.from({ length: passCount }, (_, index) => ({
        id: `${pass.id}-${index + 1}`,
        label: `Pass ${String(index + 1).padStart(2, "0")}`,
        summary: index === 0 ? "This pass" : "Additional pass in this order",
        showStatus: index === 0,
      }));

  const qrDataUrl = pass.qrToken
    ? `data:image/svg+xml;utf8,${encodeURIComponent(
        await QRCode.toString(pass.qrToken, { type: "svg", margin: 1, width: 320 })
      )}`
    : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PassWakeLock />
      {/* Browsers cannot set hardware brightness; keep pass contrast high via card styles only. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/tickets/${ticketId}`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5 text-mute hover:text-ink self-start -ml-2 text-xs"
          )}
        >
          <ArrowLeft className="size-3.5" />
          Back to ticket
        </Link>

        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={qrDataUrl ?? undefined}
              download={qrDataUrl ? `pass-${pass.id}.svg` : undefined}
              aria-disabled={!qrDataUrl}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                !qrDataUrl && "pointer-events-none opacity-50"
              )}
            >
              Download
            </a>
            <button
              type="button"
              disabled
              title="Native wallet passes ship with Phase 7 backend"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "opacity-50 cursor-not-allowed"
              )}
            >
              Add to Apple Wallet (coming soon)
            </button>
          </div>
          <p className="text-right text-xs text-mute">
            Wallet provisioning lands with the Phase 7 transfer backend.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[440px_minmax(0,1fr)] lg:items-start">
        <PassCard
          className="mx-auto w-full max-w-[440px]"
          pass={pass}
          qrDataUrl={qrDataUrl}
          eventDateLabel={eventDateLabel}
          title={eventTitle}
          subtitle={`${eventDescription} · ${venueName}`}
          sectionLabel={ticket?.ticketType?.startsWith("SEATED") ? "Seated ticket" : "General admission"}
          rowLabel={ticket?.ticketType?.startsWith("SEATED") ? primaryRowLabel : "GA"}
          seatLabel={ticket?.ticketType?.startsWith("SEATED") ? primarySeatNumber : String(passCount)}
          credentialLabel={`cred · ${pass.id.slice(0, 4)} · ${pass.id.slice(-4)}`}
          refreshLabel={pass.usedAt ? `used · ${formatShortDate(pass.usedAt)}` : "live · refresh on open"}
        />

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-mute">
              {eventDateLabel} · {venueName}
            </p>
            <h1 className="text-4xl font-semibold tracking-[-0.03em] text-ink">{eventTitle}</h1>
            <p className="text-base text-mute">
              {eventDescription} · {ticket?.event?.venueAddress ?? "Show this code at the gate"}
            </p>
          </div>

          <Card>
            <CardContent className="grid gap-px p-0 sm:grid-cols-2">
              {[
                ["Venue", venueName],
                ["Event date", eventDateLabel],
                ["Order", orderLabel],
                ["Issued", formatShortDate(pass.issuedAt)],
                ["Status", pass.status],
                ["Pass count", String(passCount)],
              ].map(([label, value], index) => (
                <div
                  key={label}
                  className={cn(
                    "flex min-h-20 flex-col gap-1 px-4 py-3",
                    index % 2 === 0 && "sm:border-r sm:border-line",
                    index < 4 && "border-b border-line"
                  )}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">{label}</span>
                  <span className={cn("text-sm font-medium text-ink", label !== "Venue" && "font-mono tabular-nums")}>
                    {value}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink">This order has {passCount} passes</h2>
                  <p className="text-sm text-mute">Transfer each pass to a friend from this list.</p>
                </div>
                <Badge tone={statusTone(pass.status)} dot>
                  {pass.status}
                </Badge>
              </div>

              <div className="flex flex-col gap-2">
                {groupPasses.map((groupPass) => (
                  <div
                    key={groupPass.id}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border border-line px-3 py-3",
                      groupPass.label === "Pass 01" && "bg-accent-soft/40"
                    )}
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg border border-line bg-subtle font-mono text-xs font-semibold tabular-nums text-ink">
                      {groupPass.label.replace("Pass ", "")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{groupPass.label}</p>
                      <p className="text-xs text-mute">{groupPass.summary}</p>
                      <p id={`transfer-note-${groupPass.id}`} className="mt-1 text-xs text-mute">
                       {pass.transferState === "PENDING"
                         ? "Transfer pending recipient acceptance."
                         : "Send this pass to a friend."}
                      </p>
                    </div>
                    {groupPass.showStatus ? (
                      <Badge tone={statusTone(pass.status)} dot>
                        {pass.status}
                      </Badge>
                    ) : null}
                    <Link
                      href={`/orders/${orderId ?? pass.orderId}/transfer`}
                      aria-describedby={`transfer-note-${groupPass.id}`}
                      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-ink")}
                    >
                      Transfer
                    </Link>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
