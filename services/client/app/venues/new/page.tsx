// app/venues/new/page.tsx — Create a new venue (auth-gated, Server Component shell).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { VenueForm } from "@/components/venue-form";
import { createVenue } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "New Venue — Ticketing" };

export default async function NewVenuePage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  return (
    <div className="flex flex-col gap-8 max-w-2xl mx-auto">
      {/* Back */}
      <Link
        href="/venues"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-mute hover:text-ink self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        My Venues
      </Link>

      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">New Venue</h1>
        <p className="mt-1 text-sm text-mute">
          Create a venue to add seating plans and attach them to tickets.
        </p>
      </div>

      <VenueForm action={createVenue} />
    </div>
  );
}
