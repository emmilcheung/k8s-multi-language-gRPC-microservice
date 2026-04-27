// app/venues/[venueId]/plans/new/page.tsx — Redirect to tickets/new
// Phase 3: Plans are created in ticket context, not venue context.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const metadata = { title: "Create Seating Plan — Ticketing" };

export default async function NewPlanPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  // Phase 3: Seating plans are now created as part of seated ticket creation.
  // Redirect to /tickets/new to create a ticket and plan together.
  redirect("/tickets/new");
}
