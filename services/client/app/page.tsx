import Link from "next/link";
import { fetchTicketPageViaGraphQL } from "@/app/actions/tickets";
import { EventPoster } from "@/components/system";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, MapPin, Calendar } from "lucide-react";
import BrowseFiltersClient from "@/app/_components/browse-filters";

const CATEGORIES = [
  { name: "Concerts", count: "—" },
  { name: "Sports", count: "—" },
  { name: "Comedy", count: "—" },
  { name: "Theatre", count: "—" },
  { name: "Festivals", count: "—" },
  { name: "Other", count: "—" },
];

export default async function HomePage() {
  const firstPage = await fetchTicketPageViaGraphQL(null).catch(() => ({
    tickets: [],
    cursor: null,
    hasMore: false,
  }));

  const tickets = firstPage.tickets;
  const heroTicket = tickets[0];
  const gridTickets = tickets.slice(1);

  const heroTitle = heroTicket?.event?.title || heroTicket?.title || "Featured Event";
  const heroDate = heroTicket?.event?.startsAt
    ? new Date(heroTicket.event.startsAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "TBA";
  const heroVenue = heroTicket?.event?.venueName || "Venue TBA";
  const heroPrice = parseFloat(heroTicket?.price || "0");

  return (
    <div className="flex flex-col">
      {/* ── Search header ─────────────────────────────────────────────────── */}
      <section className="border-b border-line bg-page px-8 py-6">
        <div className="flex items-center gap-3 max-w-2xl">
          <Input
            type="text"
            placeholder="Search events, artists, venues..."
            leading={<Search className="size-4 text-mute" />}
            className="flex-1"
          />
        </div>
      </section>

      {/* ── Quick filter chips ────────────────────────────────────────────── */}
      <section className="border-b border-line bg-card px-8 py-4 flex items-center gap-2 overflow-x-auto">
        <span className="text-sm font-medium text-ink shrink-0">Quick filters:</span>
        <Badge tone="neutral" className="shrink-0">All events</Badge>
        <Badge tone="neutral" variant="outline" className="shrink-0">Tonight</Badge>
        <Badge tone="neutral" variant="outline" className="shrink-0">Under $50</Badge>
        <Badge tone="neutral" variant="outline" className="shrink-0">This weekend</Badge>
      </section>

      {/* ── Category cards ────────────────────────────────────────────────── */}
      <section className="px-8 py-6 border-b border-line">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.name}
              className="flex flex-col gap-2 rounded-md border border-line bg-card p-3 hover:border-mute hover:bg-subtle transition-colors"
            >
              <span className="text-sm font-medium text-ink">{cat.name}</span>
              <span className="text-xs font-mono text-mute">{cat.count}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Hero event card ───────────────────────────────────────────────── */}
      {heroTicket && (
        <section className="px-8 py-6 border-b border-line">
          <Link
            href={`/tickets/${heroTicket.id}`}
            className="grid grid-cols-1 md:grid-cols-2 gap-0 rounded-lg border border-line overflow-hidden bg-card hover:border-mute transition-colors"
          >
            {/* Left: gradient stripe + text */}
            <div className="bg-gradient-to-br from-accent/80 to-accent p-8 flex flex-col justify-between text-white">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest opacity-85 mb-6">
                  Featured event
                </div>
                <h2 className="text-2xl font-semibold leading-tight mb-4">{heroTitle}</h2>
              </div>
              <div className="flex flex-col gap-3 text-sm opacity-90">
                <div className="flex items-center gap-2">
                  <Calendar className="size-4" />
                  <span>{heroDate}</span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="size-4" />
                  <span>{heroVenue}</span>
                </div>
              </div>
            </div>

            {/* Right: price + CTA */}
            <div className="p-8 flex flex-col justify-center gap-6">
              <div>
                <div className="text-xs text-mute uppercase tracking-wider mb-2">Starting at</div>
                <div className="text-3xl font-semibold font-mono tabular-nums text-ink">
                  ${heroPrice.toFixed(2)}
                </div>
                <div className="text-xs text-mute mt-2">+ fees shown at checkout</div>
              </div>
              <Button variant="primary">Get tickets</Button>
            </div>
          </Link>
        </section>
      )}

      {/* ── Main grid with filters ────────────────────────────────────────– */}
      <section className="px-8 py-6 flex gap-6">
        {/* Filter sidebar */}
        <aside className="hidden lg:flex flex-col w-56 gap-6">
          <BrowseFiltersClient />
        </aside>

        {/* Grid */}
        <div className="flex-1 flex flex-col gap-6">
          {/* Grid header + sort/view toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-ink">
                {gridTickets.length} events
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm">Sort: Date</Button>
              <div className="flex border border-line rounded-md overflow-hidden">
                <button className="px-2 py-1.5 bg-ink text-card">
                  <svg className="size-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                  </svg>
                </button>
                <button className="px-2 py-1.5 bg-card text-mute">
                  <svg className="size-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="2" />
                    <rect x="3" y="11" width="18" height="2" />
                    <rect x="3" y="18" width="18" height="2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Grid of events */}
          {gridTickets.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {gridTickets.map((ticket) => {
                const date = ticket.event?.startsAt
                  ? new Date(ticket.event.startsAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : "TBA";
                return (
                  <EventPoster
                    key={ticket.id}
                    title={ticket.event?.title || ticket.title}
                    venue={ticket.event?.venueName || "Venue TBA"}
                    date={date}
                    priceFromCents={Math.round(parseFloat(ticket.price) * 100)}
                    href={`/tickets/${ticket.id}`}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <p className="text-sm text-mute">No events available</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
