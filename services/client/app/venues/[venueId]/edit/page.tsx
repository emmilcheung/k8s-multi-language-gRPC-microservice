// app/venues/[venueId]/edit/page.tsx — Edit an existing venue (owner only).

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { fetchVenue, updateVenue } from "@/app/actions/venues";
import { VenueForm } from "@/components/venue-form";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface Props {
  params: Promise<{ venueId: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { venueId } = await params;
  try {
    const venue = await fetchVenue(venueId);
    return { title: `Edit ${venue?.name ?? "Venue"} — Ticketing` };
  } catch {
    return { title: "Edit Venue — Ticketing" };
  }
}

export default async function EditVenuePage({ params }: Props) {
  const { venueId } = await params;

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const venue = await fetchVenue(venueId);
  if (!venue) notFound();

  // Ownership check — decode JWT sub claim (Kong already verified the signature).
  let currentUserId: string | null = null;
  try {
    const payloadB64 = token.split(".")[1];
    if (payloadB64) {
      const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
      const payload = JSON.parse(json) as { sub?: string };
      currentUserId = payload.sub ?? null;
    }
  } catch { /* non-fatal */ }

  if (!currentUserId || currentUserId !== venue.organizerId) notFound();

  const updateAction = updateVenue.bind(null, venueId);

  return (
    <div className="flex flex-col items-center gap-8 py-4">
      <div className="w-full max-w-md">
        <Link
          href={`/venues/${venueId}`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to venue
        </Link>
      </div>

      <div className="w-full max-w-md flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Edit venue</h1>
        <p className="text-sm text-muted-foreground">
          Update your venue details.
        </p>
      </div>

      <VenueForm
        action={updateAction}
        defaultName={venue.name}
        defaultCapacity={venue.capacity}
        defaultTimezone={venue.timezone ?? ""}
        defaultAddress={venue.address ?? ""}
        submitLabel="Save Changes"
      />
    </div>
  );
}
