// app/page.tsx — Landing page: hero section + available ticket grid (Server Component).
// The first page of tickets is fetched server-side for instant SSR. Subsequent
// pages are loaded on demand by the TicketGrid Client Component (P-02).

import Link from "next/link";
import { fetchTicketPage } from "@/app/actions/tickets";
import { TicketGrid } from "@/components/ticket-grid";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { Ticket as TicketIcon, ArrowRight, Tag, Zap, Shield, Globe } from "lucide-react";

export default async function HomePage() {
  // Fetch first page server-side — benefits from ISR caching in fetchTicketPage.
  const firstPage = await fetchTicketPage(null).catch(() => ({
    tickets: [],
    cursor: null,
    hasMore: false,
  }));

  const availableCount = firstPage.tickets.filter((t) => !t.orderId).length;

  return (
    <div className="flex flex-col gap-20">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative pt-12 pb-4 flex flex-col items-center text-center gap-6">
        {/* Pill badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium">
          <Zap className="w-3 h-3" />
          Live ticket marketplace
        </div>

        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1] max-w-2xl">
          Your next event{" "}
          <span className="gradient-text">starts here</span>
        </h1>

        <p className="text-lg text-muted-foreground max-w-md leading-relaxed">
          Buy and sell event tickets instantly. No fees, no friction — just you
          and the events you love.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            href="/#tickets"
            className={cn(
              buttonVariants({ size: "lg" }),
              "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
            )}
          >
            Browse Tickets
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/tickets/new"
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "gap-2 border-white/10 hover:bg-white/5"
            )}
          >
            <Tag className="w-4 h-4" />
            Sell a Ticket
          </Link>
        </div>

        {/* Stats strip */}
        <div className="mt-6 flex flex-wrap justify-center gap-8 text-sm text-muted-foreground">
          {[
            { icon: TicketIcon, label: `${Math.max(availableCount, 10)}+ tickets listed` },
            { icon: Shield, label: "Secure checkout" },
            { icon: Globe, label: "All events welcome" },
          ].map(({ icon: Icon, label }) => (
            <span key={label} className="flex items-center gap-1.5">
              <Icon className="w-4 h-4 text-primary/70" />
              {label}
            </span>
          ))}
        </div>
      </section>

      {/* ── Ticket grid ──────────────────────────────────────────────────── */}
      <section id="tickets" className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">
            Available Tickets
            {availableCount > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({availableCount}{firstPage.hasMore ? "+" : ""})
              </span>
            )}
          </h2>
          <Link
            href="/tickets/new"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "gap-1.5 text-muted-foreground hover:text-foreground"
            )}
          >
            <Tag className="w-3.5 h-3.5" />
            List yours
          </Link>
        </div>

        {/* Client Component: handles "Load more" interactivity */}
        <TicketGrid
          initialTickets={firstPage.tickets}
          initialCursor={firstPage.cursor}
          initialHasMore={firstPage.hasMore}
        />
      </section>
    </div>
  );
}
