import Link from "next/link";
import { fetchTicketPage } from "@/app/actions/tickets";
import { TicketGrid } from "@/components/ticket-grid";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { Tag, ArrowRight } from "lucide-react";

export default async function HomePage() {
  const firstPage = await fetchTicketPage(null).catch(() => ({
    tickets: [],
    cursor: null,
    hasMore: false,
  }));

  const availableCount = firstPage.tickets.filter((t) => !t.orderId).length;

  return (
    <div className="flex flex-col gap-16">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="pt-8 pb-4 flex flex-col gap-8">
        {/* Label */}
        <div className="flex items-center gap-2">
          <span className="inline-block h-px w-8 bg-primary" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Live Ticket Marketplace
          </span>
        </div>

        {/* Headline */}
        <div className="flex flex-col gap-4 max-w-3xl">
          <h1
            className="font-display font-extrabold leading-[0.95] tracking-tight"
            style={{ fontSize: "clamp(3rem, 8vw, 5.5rem)" }}
          >
            <span className="text-foreground">Find your</span>{" "}
            <br />
            <span className="gradient-text">next show.</span>
          </h1>
          <p className="text-base text-muted-foreground max-w-sm leading-relaxed">
            Buy and sell tickets to live events. No hidden fees, instant checkout.
          </p>
        </div>

        {/* CTAs + stats in one row */}
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <Link
              href="/#tickets"
              className={cn(
                buttonVariants(),
                "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              )}
            >
              Browse Tickets
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/tickets/new"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "gap-2 border-border hover:bg-muted font-medium"
              )}
            >
              <Tag className="size-4" />
              Sell a Ticket
            </Link>
          </div>

          {/* Divider */}
          <span className="hidden sm:block h-6 w-px bg-border" />

          {/* Stats */}
          <div className="flex items-center gap-5 text-sm">
            <div className="flex flex-col">
              <span className="font-display font-bold text-foreground text-lg leading-none">
                {Math.max(availableCount, 10)}+
              </span>
              <span className="text-xs text-muted-foreground mt-0.5">tickets listed</span>
            </div>
            <div className="flex flex-col">
              <span className="font-display font-bold text-foreground text-lg leading-none">
                0%
              </span>
              <span className="text-xs text-muted-foreground mt-0.5">platform fees</span>
            </div>
            <div className="flex flex-col">
              <span className="font-display font-bold text-foreground text-lg leading-none">
                All
              </span>
              <span className="text-xs text-muted-foreground mt-0.5">events welcome</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Ticket grid ──────────────────────────────────────────────────── */}
      <section id="tickets" className="flex flex-col gap-6">
        {/* Section header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-block h-5 w-0.5 bg-primary" />
            <h2 className="font-display font-bold text-base uppercase tracking-widest">
              Available Tickets
            </h2>
            {availableCount > 0 && (
              <span className="text-xs text-muted-foreground font-medium">
                {availableCount}{firstPage.hasMore ? "+" : ""} listings
              </span>
            )}
          </div>
          <Link
            href="/tickets/new"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "gap-1.5 text-muted-foreground hover:text-foreground text-xs"
            )}
          >
            <Tag className="size-3.5" />
            List yours
          </Link>
        </div>

        <TicketGrid
          initialTickets={firstPage.tickets}
          initialCursor={firstPage.cursor}
          initialHasMore={firstPage.hasMore}
        />
      </section>
    </div>
  );
}
