// app/tickets/new/page.tsx — Create a new ticket (authenticated).
// Redirects to sign-in if user has no token cookie.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createTicket } from "@/app/actions/tickets";
import { TicketForm } from "@/components/ticket-form";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

export const metadata = { title: "Sell a Ticket — Ticketing" };

export default async function NewTicketPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  return (
    <div className="flex flex-col items-center gap-8 py-4">
      {/* Back link */}
      <div className="w-full max-w-md">
        <Link
          href="/"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5 text-mute hover:text-ink -ml-2"
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to listings
        </Link>
      </div>

      {/* Heading */}
      <div className="w-full max-w-md flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">List a ticket</h1>
        <p className="text-sm text-mute">
          Set your price and let buyers find you on the marketplace.
        </p>
      </div>

      <TicketForm action={createTicket} submitLabel="Create Ticket" />
    </div>
  );
}
