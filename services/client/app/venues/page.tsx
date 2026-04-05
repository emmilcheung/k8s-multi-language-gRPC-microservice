// app/venues/page.tsx — Organizer's venue list (Server Component, auth-gated).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchMyVenues } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { Building2, Plus, ArrowLeft, MapPin, Users, ArrowRight } from "lucide-react";

export const metadata = { title: "My Venues — Marquee" };

export default async function VenuesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const venues = await fetchMyVenues();

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href="/"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="size-3.5" />
        Home
      </Link>

      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block h-px w-6 bg-primary" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Venues
            </span>
          </div>
          <h1 className="font-display font-extrabold text-2xl tracking-tight">My Venues</h1>
          <p className="text-sm text-muted-foreground">Manage venues and seating plans.</p>
        </div>
        <Link
          href="/venues/new"
          className={cn(
            buttonVariants({ size: "sm" }),
            "gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shrink-0"
          )}
        >
          <Plus className="size-3.5" />
          New Venue
        </Link>
      </div>

      {venues.length === 0 ? (
        <div className="border border-border rounded bg-card p-12 flex flex-col items-center gap-5 text-center">
          <div className="flex items-center justify-center size-14 rounded bg-muted">
            <Building2 className="size-7 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="font-display font-bold text-lg">No venues yet</h2>
            <p className="text-sm text-muted-foreground">
              Create your first venue to start building seating plans.
            </p>
          </div>
          <Link
            href="/venues/new"
            className={cn(buttonVariants(), "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground")}
          >
            <Plus className="size-4" />
            Create Venue
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {venues.map((venue) => (
            <Link
              key={venue.id}
              href={`/venues/${venue.id}`}
              className="group bg-card border border-border border-l-[3px] border-l-primary/40 hover:border-l-primary rounded overflow-hidden p-5 flex flex-col gap-3 transition-all hover:shadow-sm"
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center size-9 rounded bg-primary/10 shrink-0">
                  <Building2 className="size-4 text-primary" />
                </div>
                <h3 className="font-display font-bold text-sm group-hover:text-primary transition-colors line-clamp-1">
                  {venue.name}
                </h3>
              </div>

              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="size-3.5" />
                  {venue.capacity.toLocaleString()} capacity
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-3.5" />
                  {venue.timezone}
                </span>
              </div>

              <div className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-primary transition-colors mt-1">
                Manage
                <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
