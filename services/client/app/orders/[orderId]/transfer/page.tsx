import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { executeQuery } from "@/lib/graphql/execute";
import { AdmissionPassDocument, OrderPageDocument } from "@/lib/graphql/generated";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TransferForm } from "./_components/transfer-form";

interface Props {
  params: Promise<{ orderId: string }>;
}

export default async function TransferPage({ params }: Props) {
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
  const passData = await executeQuery(
    AdmissionPassDocument,
    { ticketId: data.order.ticket.id, orderId },
    { cookie: cookieStore.toString() }
  ).catch(() => null);

  if (!passData?.admissionPass) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <Link href={`/orders/${orderId}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5 self-start -ml-2")}>
        <ArrowLeft className="size-3.5" />
        Back to order
      </Link>

      <div className="rounded-xl border border-line bg-card p-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Transfer pass</h1>
        <p className="mt-2 text-sm text-mute">Send this order&apos;s pass to a friend by entering their email.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-line bg-card">
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold text-ink">Which seat are you sending?</h2>
            </div>
            <div className="px-5 py-4">
              <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5">
                <span className="inline-flex size-9 items-center justify-center rounded-md border border-accent/30 bg-accent font-mono text-xs font-semibold text-on-accent">
                  P01
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{data.order.ticket.title}</p>
                  <p className="text-xs text-mute">Credential {passData.admissionPass.id.slice(0, 8)}…</p>
                </div>
                <Badge tone="accent">selected</Badge>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-line bg-card p-5">
            <TransferForm orderId={orderId} credentialId={passData.admissionPass.id} />
          </section>
        </div>

        <aside className="flex h-fit flex-col gap-3 rounded-xl border border-line bg-card p-5 lg:sticky lg:top-20">
          <h2 className="text-sm font-semibold text-ink">They&apos;ll receive</h2>
          <div className="rounded-lg border border-line bg-subtle p-3">
            <p className="text-sm font-medium text-ink">{data.order.ticket.title}</p>
            <p className="mt-1 text-xs text-mute">Order {orderId.slice(0, 8).toUpperCase()} · qty {data.order.quantity}</p>
          </div>
          <div className="rounded-lg border border-line px-3 py-2.5 text-xs text-mute">
            Transfer can be recalled before check-in. The recipient gets a claim link by email.
          </div>
        </aside>
      </div>
    </div>
  );
}
