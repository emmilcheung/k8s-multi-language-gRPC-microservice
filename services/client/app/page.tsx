// app/page.tsx — Landing page: hero section + available ticket grid (Server Component).

import Link from "next/link";
import { serverApi } from "@/lib/api";
import type { Ticket } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Ticket as TicketIcon, ArrowRight, Tag, Zap, Shield, Globe } from "lucide-react";

async function getTickets(): Promise<Ticket[]> {
  try {
    return await serverApi<Ticket[]>("/api/tickets");
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const tickets = await getTickets();
  const available = tickets.filter((t) => !t.orderId);

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
            { icon: TicketIcon, label: `${Math.max(available.length, 10)}+ tickets listed` },
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
            {available.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({available.length})
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

        {available.length === 0 ? (
          /* Empty state */
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
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} />
            ))}
          </div>
        )}
      </section>
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
