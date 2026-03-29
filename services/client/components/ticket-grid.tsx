"use client";
// components/ticket-grid.tsx — Client Component that renders the ticket grid
// with cursor-based "Load more" pagination (P-02).
//
// The initial page is fetched server-side in page.tsx and passed as props,
// ensuring the first paint is fast and SSR-friendly. Subsequent pages are
// fetched by calling the `fetchTicketPage` Server Action directly from the
// browser — no REST endpoint exposed to the client.

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Tag, Ticket as TicketIcon, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { Ticket } from "@/lib/types";
import { fetchTicketPage } from "@/app/actions/tickets";

interface TicketGridProps {
  /** First page of tickets, rendered server-side for instant display. */
  initialTickets: Ticket[];
  /** Cursor to use for the second page (`null` means there is no second page). */
  initialCursor: string | null;
  /** Whether more pages are available after the initial page. */
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
      <div className="glass rounded-2xl flex flex-col items-center gap-4 py-20 px-8 text-center">
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 ring-1 ring-primary/20">
          <TicketIcon className="w-8 h-8 text-primary/60" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-lg">No tickets yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Be the first to list a ticket and set the market price.
          </p>
        </div>
        <Link
          href="/tickets/new"
          className={cn(
            buttonVariants(),
            "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-2"
          )}
        >
          <Tag className="w-4 h-4" />
          List a Ticket
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              "gap-2 border-white/10 hover:bg-white/5 min-w-32"
            )}
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                Load more
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className="group relative flex flex-col gap-4 glass rounded-2xl p-5 transition-all duration-200 hover:scale-[1.02] hover:glow-violet hover:border-primary/30 cursor-pointer"
    >
      {/* Top row: icon + price badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
          <TicketIcon className="w-5 h-5 text-primary/80" />
        </div>
        <Badge className="bg-primary/15 text-primary border-primary/20 font-semibold text-sm px-2.5 py-0.5 shrink-0">
          ${ticket.price.toFixed(2)}
        </Badge>
      </div>

      {/* Title */}
      <p className="font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors">
        {ticket.title}
      </p>

      {/* CTA */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-primary/80 transition-colors mt-auto">
        View ticket
        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
