// Quick facts strip component — displays date, venue, age rating, status

import { Badge } from "@/components/ui/badge";
import { CalendarDays, MapPin } from "lucide-react";
import type { Ticket } from "@/lib/types";

interface QuickFactsProps {
  ticket: Ticket;
  gaRemaining: number | null;
}

export function QuickFacts({ ticket, gaRemaining }: QuickFactsProps) {
  const dateStr = ticket.event?.startsAt
    ? new Date(ticket.event.startsAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "long",
        day: "numeric",
      })
    : "—";

  const venueStr = ticket.event?.venueName ?? "TBA";

  return (
    <div className="border-y border-line py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
      {/* Date */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-mute uppercase tracking-wider font-medium">
          Date
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-accent shrink-0" />
          <span className="text-sm font-semibold text-ink">{dateStr}</span>
        </div>
      </div>

      {/* Venue */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-mute uppercase tracking-wider font-medium">
          Venue
        </div>
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-accent shrink-0" />
          <span className="text-sm font-semibold text-ink">{venueStr}</span>
        </div>
      </div>

      {/* Age rating */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-mute uppercase tracking-wider font-medium">
          Age
        </div>
        <span className="text-sm font-semibold text-ink">All ages</span>
      </div>

      {/* Status / Availability */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-mute uppercase tracking-wider font-medium">
          Status
        </div>
        {gaRemaining != null ? (
          <span className="text-sm font-semibold text-ink font-mono tabular-nums">
            {gaRemaining} left
          </span>
        ) : (
          <Badge tone={(ticket.available ?? 0) > 0 ? "ok" : "bad"}>
            {(ticket.available ?? 0) > 0 ? "On sale" : "Sold out"}
          </Badge>
        )}
      </div>
    </div>
  );
}
