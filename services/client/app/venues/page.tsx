// app/venues/page.tsx — Organizer's venue list (Server Component, auth-gated).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchMyVenues } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Building2, Plus, ArrowLeft, MapPin, Users } from "lucide-react";

export const metadata = { title: "My Venues — Ticketing" };

export default async function VenuesPage() {
  // Auth gate — redirect to sign-in if no token cookie.
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
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Home
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight gradient-text">My Venues</h1>
          <p className="text-muted-foreground mt-1">
            Manage your venues and seating plans.
          </p>
        </div>
        <Link
          href="/venues/new"
          className={cn(
            buttonVariants({ size: "sm" }),
            "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
          )}
        >
          <Plus className="w-3.5 h-3.5" />
          New Venue
        </Link>
      </div>

      {/* Venue list */}
      {venues.length === 0 ? (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-4 text-center">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 ring-1 ring-primary/20">
            <Building2 className="w-8 h-8 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">No venues yet</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Create your first venue to start building seating plans.
            </p>
          </div>
          <Link
            href="/venues/new"
            className={cn(
              buttonVariants(),
              "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-2"
            )}
          >
            <Plus className="w-4 h-4" />
            Create Venue
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {venues.map((venue) => (
            <Link
              key={venue.id}
              href={`/venues/${venue.id}`}
              className="glass rounded-2xl p-6 flex flex-col gap-3 hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
                  <Building2 className="w-5 h-5 text-primary" />
                </div>
                <Badge className="bg-primary/15 text-primary border-primary/20 text-xs">
                  Venue
                </Badge>
              </div>

              <div>
                <h3 className="font-semibold text-base group-hover:text-primary transition-colors">
                  {venue.name}
                </h3>
              </div>

              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  {venue.capacity.toLocaleString()} capacity
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  {venue.timezone}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
