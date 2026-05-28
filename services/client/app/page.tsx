import Link from "next/link";
import { fetchTicketPageViaGraphQL } from "@/app/actions/tickets";
import { EventPoster } from "@/components/system";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, MapPin, Calendar } from "lucide-react";
import BrowseFiltersClient from "@/app/_components/browse-filters";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { name: "Concerts", query: "concert" },
  { name: "Sports", query: "sport" },
  { name: "Comedy", query: "comedy" },
  { name: "Theatre", query: "theatre" },
  { name: "Festivals", query: "festival" },
  { name: "Other", query: "event" },
];

interface HomePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function pickString(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function HomePage({ searchParams }: HomePageProps = {}) {
  const resolvedParams = (await searchParams) ?? {};
  const query = (pickString(resolvedParams.q) ?? "").trim().toLowerCase();
  const maxPriceRaw = pickString(resolvedParams.maxPrice);
  const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : null;
  const dateFilter = pickString(resolvedParams.date);
  const sort = pickString(resolvedParams.sort) === "price" ? "price" : "date";
  const view = pickString(resolvedParams.view) === "list" ? "list" : "grid";

  const buildHref = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(resolvedParams)) {
      const asString = pickString(value);
      if (asString) next.set(key, asString);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value && value.length > 0) next.set(key, value);
      else next.delete(key);
    }
    const queryString = next.toString();
    return queryString ? `/?${queryString}` : "/";
  };

  const firstPage = await fetchTicketPageViaGraphQL(null).catch(() => ({
    tickets: [],
    cursor: null,
    hasMore: false,
  }));

  const now = new Date();
  const tickets = firstPage.tickets
    .filter((ticket) => {
      if (!query) return true;
      const haystack = [
        ticket.title,
        ticket.event?.title ?? "",
        ticket.event?.venueName ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .filter((ticket) => {
      if (maxPrice == null || Number.isNaN(maxPrice)) return true;
      return parseFloat(ticket.price) <= maxPrice;
    })
    .filter((ticket) => {
      if (!dateFilter) return true;
      if (!ticket.event?.startsAt) return false;
      const startsAt = new Date(ticket.event.startsAt);
      if (Number.isNaN(startsAt.getTime())) return false;
      if (dateFilter === "tonight") {
        return startsAt.toDateString() === now.toDateString();
      }
      if (dateFilter === "weekend") {
        const day = startsAt.getDay();
        return day === 0 || day === 6;
      }
      return true;
    })
    .sort((a, b) => {
      if (sort === "price") {
        return parseFloat(a.price) - parseFloat(b.price);
      }
      const aTs = a.event?.startsAt ? new Date(a.event.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTs = b.event?.startsAt ? new Date(b.event.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aTs - bTs;
    });
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
        <form action="/" className="flex items-center gap-3 max-w-2xl">
          <Input
            name="q"
            type="text"
            placeholder="Search events, artists, venues..."
            defaultValue={query}
            leading={<Search className="size-4 text-mute" />}
            className="flex-1"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </section>

      {/* ── Quick filter chips ────────────────────────────────────────────── */}
      <section className="border-b border-line bg-card px-8 py-4 flex items-center gap-2 overflow-x-auto">
        <span className="text-sm font-medium text-ink shrink-0">Quick filters:</span>
        <Link href={buildHref({ date: null, maxPrice: null })} className="shrink-0">
          <Badge tone="neutral" className="shrink-0">All events</Badge>
        </Link>
        <Link href={buildHref({ date: "tonight" })} className="shrink-0">
          <Badge tone="neutral" variant="outline" className="shrink-0">Tonight</Badge>
        </Link>
        <Link href={buildHref({ maxPrice: "50" })} className="shrink-0">
          <Badge tone="neutral" variant="outline" className="shrink-0">Under $50</Badge>
        </Link>
        <Link href={buildHref({ date: "weekend" })} className="shrink-0">
          <Badge tone="neutral" variant="outline" className="shrink-0">This weekend</Badge>
        </Link>
      </section>

      {/* ── Category cards ────────────────────────────────────────────────── */}
      <section className="px-8 py-6 border-b border-line">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.name}
              href={buildHref({ q: cat.query })}
              className="flex flex-col gap-2 rounded-md border border-line bg-card p-3 hover:border-mute hover:bg-subtle transition-colors"
            >
              <span className="text-sm font-medium text-ink">{cat.name}</span>
              <span className="text-xs font-mono text-mute">search</span>
            </Link>
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
              <span className="inline-flex items-center justify-center rounded-[min(var(--radius-md),12px)] bg-accent px-4 py-2.5 text-sm font-medium text-on-accent">
                Get tickets
              </span>
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
              <Link href={buildHref({ sort: sort === "date" ? "price" : "date" })}>
                <Button variant="ghost" size="sm">Sort: {sort === "date" ? "Date" : "Price"}</Button>
              </Link>
              <div className="flex border border-line rounded-md overflow-hidden">
                <Link
                  href={buildHref({ view: "grid" })}
                  aria-label="Grid view"
                  className={cn("px-2 py-1.5", view === "grid" ? "bg-ink text-card" : "bg-card text-mute")}
                >
                  <svg className="size-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                  </svg>
                </Link>
                <Link
                  href={buildHref({ view: "list" })}
                  aria-label="List view"
                  className={cn("px-2 py-1.5", view === "list" ? "bg-ink text-card" : "bg-card text-mute")}
                >
                  <svg className="size-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="2" />
                    <rect x="3" y="11" width="18" height="2" />
                    <rect x="3" y="18" width="18" height="2" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>

          {/* Grid of events */}
          {gridTickets.length > 0 ? (
            <div className={cn("gap-4", view === "grid" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col")}>
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
                    className={view === "list" ? "sm:max-w-none lg:max-w-none" : undefined}
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
