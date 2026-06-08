import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { executeQuery } from "@/lib/graphql/execute";
import { OrderPageDocument, RefundEligibilityDocument } from "@/lib/graphql/generated";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RefundForm } from "./_components/refund-form";

interface Props {
  params: Promise<{ orderId: string }>;
}

export default async function RefundPage({ params }: Props) {
  const { orderId } = await params;
  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const data = await executeQuery(
    OrderPageDocument,
    { id: orderId },
    { cookie: cookieStore.toString() }
  ).catch(() => null);

  if (!data?.order) {
    notFound();
  }

  const eligibilityData = await executeQuery(
    RefundEligibilityDocument,
    { orderId },
    { cookie: cookieStore.toString() }
  ).catch(() => null);
  const eligibility = eligibilityData?.refundEligibility ?? null;
  const isEligible = Boolean(eligibility?.eligible);
  const refundableAmount =
    eligibility?.refundableAmount != null ? (eligibility.refundableAmount / 100).toFixed(2) : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <Link href={`/orders/${orderId}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5 self-start -ml-2")}>
        <ArrowLeft className="size-3.5" />
        Back to order
      </Link>

      <div className="rounded-xl border border-line bg-card p-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Request refund</h1>
        <p className="mt-2 text-sm text-mute">
          Share why you can no longer attend and we will submit your request.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <section className={cn(
            "rounded-xl border bg-card p-4",
            isEligible ? "border-ok/30" : "border-bad/30"
          )}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn("text-sm font-semibold", isEligible ? "text-ok" : "text-bad")}>
                  {isEligible ? "You're eligible for a full refund" : "This order is not currently eligible"}
                </p>
                <p className="mt-1 text-xs text-mute">
                  {eligibility?.cutoffAt
                    ? `Window closes ${new Date(eligibility.cutoffAt).toLocaleString()}`
                    : "Eligibility is based on event policy and payment status."}
                </p>
              </div>
              <Badge tone={isEligible ? "ok" : "bad"}>{isEligible ? "eligible" : "blocked"}</Badge>
            </div>
            {eligibility?.reason && !isEligible ? (
              <p className="mt-2 text-xs text-bad">{eligibility.reason}</p>
            ) : null}
          </section>

          <section className="rounded-xl border border-line bg-card p-5">
            {isEligible ? (
              <RefundForm orderId={orderId} />
            ) : (
              <p className="text-sm text-mute">Refund request is unavailable for this order at the moment.</p>
            )}
          </section>
        </div>

        <aside className="flex h-fit flex-col gap-3 rounded-xl border border-line bg-card p-5 lg:sticky lg:top-20">
          <h2 className="text-sm font-semibold text-ink">Refund summary</h2>
          <div className="rounded-lg border border-line bg-subtle p-3">
            <p className="text-sm font-medium text-ink">{data.order.ticket.title}</p>
            <p className="mt-1 text-xs text-mute">Order {orderId.slice(0, 8).toUpperCase()} · qty {data.order.quantity}</p>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
            <span className="text-xs text-mute">Refund to original method</span>
            <span className="font-mono text-sm font-semibold text-ink">
              {refundableAmount ? `$${refundableAmount}` : "—"}
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
