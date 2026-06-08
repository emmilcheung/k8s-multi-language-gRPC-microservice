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
          "gap-1.5 text-mute hover:text-ink self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="size-3.5" />
        Home
      </Link>

      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block h-px w-6 bg-accent" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
              Venues
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">My Venues</h1>
          <p className="text-sm text-mute">Manage venues and seating plans.</p>
        </div>
        <Link
          href="/venues/new"
          className={cn(
            buttonVariants({ variant: "accent", size: "sm" }),
            "gap-1.5 font-semibold shrink-0"
          )}
        >
          <Plus className="size-3.5" />
          New Venue
        </Link>
      </div>

      {venues.length === 0 ? (
        <div className="rounded-xl border border-line bg-card p-12 flex flex-col items-center gap-5 text-center">
          <div className="flex items-center justify-center size-14 rounded-lg bg-subtle">
            <Building2 className="size-7 text-mute" />
          </div>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-ink">No venues yet</h2>
            <p className="text-sm text-mute">
              Create your first venue to start building seating plans.
            </p>
          </div>
          <Link
            href="/venues/new"
            className={cn(buttonVariants({ variant: "accent" }), "gap-2")}
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
              className="group rounded-xl bg-card border border-line border-l-[3px] border-l-accent/40 hover:border-l-accent p-5 flex flex-col gap-3 transition-all"
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center size-9 rounded-lg bg-accent-soft shrink-0">
                  <Building2 className="size-4 text-accent" />
                </div>
                <h3 className="text-sm font-semibold text-ink group-hover:text-accent transition-colors line-clamp-1">
                  {venue.name}
                </h3>
              </div>

              <div className="flex items-center gap-4 text-xs text-mute">
                <span className="flex items-center gap-1.5">
                  <Users className="size-3.5" />
                  {venue.capacity.toLocaleString()} capacity
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-3.5" />
                  {venue.timezone}
                </span>
              </div>

              <div className="flex items-center gap-1 text-xs text-mute group-hover:text-accent transition-colors mt-1">
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
