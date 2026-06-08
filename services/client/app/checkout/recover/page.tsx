import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertCircle, ArrowRight, Info, Map, RotateCcw } from "lucide-react";
import { OrderPageDocument, TicketDetailDocument } from "@/lib/graphql/generated";
import { executeQuery } from "@/lib/graphql/execute";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

type RecoverPageProps = {
  searchParams: Promise<{ orderId?: string }>;
};

export const metadata = {
  title: "Recover checkout — Marquee",
};

function formatExpiredAt(value?: string | null) {
  if (!value) return "a few moments ago";

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function CheckoutRecoverPage({ searchParams }: RecoverPageProps) {
  const { orderId } = await searchParams;
  if (!orderId) {
    notFound();
  }

  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const cookieHeader = cookieStore.toString();
  const orderData = await executeQuery(OrderPageDocument, { id: orderId }, { cookie: cookieHeader });
  if (!orderData.order) {
    notFound();
  }

  const order = orderData.order;
  const orderExpiresAt = order.expiresAt ?? null;
  const isExpiredCreatedOrder =
    order.status.toLowerCase() === "created" &&
    orderExpiresAt !== null &&
    new Date(orderExpiresAt) < new Date();
  if (!isExpiredCreatedOrder) {
    redirect(`/orders/${order.id}`);
  }

  const ticketData = await executeQuery(TicketDetailDocument, { id: order.ticket.id }, { cookie: cookieHeader });
  if (!ticketData.ticket) {
    notFound();
  }

  const ticket = ticketData.ticket;
  const eventTitle = ticket.event?.title ?? order.ticket.title;
  const venueName = ticket.event?.venueName ?? "the event page";
  const retryHref = ticket.seatingPlan ? `/tickets/${ticket.id}/seats?retry=same&orderId=${order.id}` : `/tickets/${ticket.id}`;
  const secondaryHref = ticket.seatingPlan ? `/tickets/${ticket.id}/seats` : `/`;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 py-8">
      <Card elev>
        <CardHeader className="flex flex-row items-center gap-4 border-b border-line pb-5">
          <span className="flex size-11 items-center justify-center rounded-full border border-warn/25 bg-warn-soft text-warn">
            <AlertCircle className="size-5" />
          </span>
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">Heads up</p>
            <CardTitle className="text-[22px] tracking-[-0.018em]">Your hold expired</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 py-6">
          <p className="max-w-2xl text-sm leading-6 text-ink">
            We hold seats for 10 minutes while you check out. Your timer ran out at{" "}
            <span className="font-mono font-medium text-ink">{formatExpiredAt(order.expiresAt)}</span>, so{" "}
            <span className="font-medium text-ink">{eventTitle}</span> went back into the pool. No charges were
            made.
          </p>

          <div className="space-y-4 rounded-md border border-line bg-subtle p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-mute">What you can do</p>
            <div className="space-y-4">
              <div className="flex gap-3">
                <span className="mt-0.5 flex size-6 items-center justify-center rounded-md border border-line bg-card text-accent">
                  <RotateCcw className="size-3.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">Try again from the seat map</p>
                  <p className="text-xs leading-5 text-mute">
                    Jump straight back into checkout for {eventTitle} at {venueName}.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="mt-0.5 flex size-6 items-center justify-center rounded-md border border-line bg-card text-accent">
                  <Map className="size-3.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">Pick different seats</p>
                  <p className="text-xs leading-5 text-mute">
                    Open the latest availability and choose another spot before inventory moves again.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href={retryHref} className={cn(buttonVariants({ variant: "primary" }), "gap-2")}>
              Reserve the same seats
              <ArrowRight className="size-4" />
            </Link>
            <Link href={secondaryHref} className={cn(buttonVariants({ variant: "outline" }), "gap-2")}>
              Open seat map
            </Link>
            <Link href={`/tickets/${ticket.id}`} className={buttonVariants({ variant: "ghost" })}>
              Back to event
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="mt-0.5 size-4 text-mute" />
          <CardDescription className="text-sm leading-6">
            Tip: save a payment method in Settings to speed through checkout next time.
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  );
}
