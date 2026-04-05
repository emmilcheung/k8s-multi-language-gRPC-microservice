"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Tag, Ticket as TicketIcon, Loader2, ShoppingBag, Armchair, Zap, MapPin, CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { Ticket } from "@/lib/types";
import { fetchTicketPage } from "@/app/actions/tickets";

interface TicketGridProps {
  initialTickets: Ticket[];
  initialCursor: string | null;
  initialHasMore: boolean;
}

export function TicketGrid({
  initialTickets,
  initialCursor,
  initialHasMore,
}: TicketGridProps) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isPending, startTransition] = useTransition();

  const available = tickets.filter((t) => !t.orderId);

  function loadMore() {
    if (!cursor || isPending) return;
    startTransition(async () => {
      const page = await fetchTicketPage(cursor);
      setTickets((prev) => [...prev, ...page.tickets]);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    });
  }

  if (available.length === 0) {
    return (
      <div className="border border-border rounded bg-card flex flex-col items-center gap-5 py-20 px-8 text-center">
        <div className="flex items-center justify-center size-14 rounded bg-muted">
          <TicketIcon className="size-7 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-display font-bold text-lg">No tickets yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Be the first to list a ticket and set the market price.
          </p>
        </div>
        <Link
          href="/tickets/new"
          className={cn(buttonVariants(), "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground")}
        >
          <Tag className="size-4" />
          List a Ticket
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {available.map((ticket) => (
          <TicketCard key={ticket.id} ticket={ticket} />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={loadMore}
            disabled={isPending}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "gap-2 min-w-32"
            )}
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                Load more
                <ArrowRight className="size-3.5" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  const eventDate = ticket.event?.startsAt
    ? new Date(ticket.event.startsAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }).toUpperCase()
    : null;

  const eventTime = ticket.event?.startsAt
    ? new Date(ticket.event.startsAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const typeInfo = {
    GA: { label: "GA", icon: <ShoppingBag className="size-3" /> },
    SEATED_MANUAL: { label: "Seated", icon: <Armchair className="size-3" /> },
    SEATED_AUTO: { label: "Auto", icon: <Zap className="size-3" /> },
  }[ticket.ticketType ?? ""] ?? null;

  const remaining =
    ticket.ticketType === "GA" && ticket.quota != null && ticket.sold != null
      ? Math.max(0, ticket.quota - ticket.sold)
      : null;

  const venueName = ticket.event?.venueName ?? null;

  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className="group relative flex flex-col bg-card border border-border rounded overflow-hidden transition-all duration-150 hover:shadow-md hover:border-primary/30"
    >
      {/* Left accent bar */}
      <span className="absolute left-0 top-0 bottom-0 w-0.75 bg-primary" />

      {/* Card body */}
      <div className="pl-5 pr-4 pt-4 pb-4 flex flex-col gap-3 flex-1">
        {/* Top row: date + price */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium min-w-0">
            {eventDate ? (
              <>
                <CalendarDays className="size-3 shrink-0 text-primary/60" />
                <span className="truncate">{eventDate}{eventTime ? ` · ${eventTime}` : ""}</span>
              </>
            ) : (
              <span className="text-muted-foreground/50 italic text-xs">No date set</span>
            )}
          </div>
          <span className="font-display font-bold text-base text-foreground shrink-0 group-hover:text-primary transition-colors">
            ${parseFloat(ticket.price).toFixed(2)}
          </span>
        </div>

        {/* Event / ticket title */}
        <p className="font-display font-bold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
          {ticket.event?.title || ticket.title}
        </p>

        {/* Venue */}
        {venueName && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">{venueName}</span>
          </div>
        )}

        {/* Footer: type + remaining + arrow */}
        <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-border">
          <div className="flex items-center gap-1.5 flex-wrap">
            {typeInfo && (
              <Badge variant="secondary" className="gap-1 text-xs px-1.5 py-0 font-medium rounded">
                {typeInfo.icon}
                {typeInfo.label}
              </Badge>
            )}
            {remaining !== null && (
              <span className="text-xs text-muted-foreground">
                {remaining} left
              </span>
            )}
          </div>
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground group-hover:text-primary transition-colors shrink-0">
            View
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}
