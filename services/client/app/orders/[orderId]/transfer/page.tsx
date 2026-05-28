import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { executeQuery } from "@/lib/graphql/execute";
import { OrderPageDocument } from "@/lib/graphql/generated";
import { buttonVariants } from "@/components/ui/button-variants";
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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href={`/orders/${orderId}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5 self-start -ml-2")}>
        <ArrowLeft className="size-3.5" />
        Back to order
      </Link>

      <div className="rounded-xl border border-line bg-card p-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Transfer pass</h1>
        <p className="mt-2 text-sm text-mute">
          Send this order&apos;s pass to a friend by entering their email.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-card p-5">
        <TransferForm orderId={orderId} />
      </div>
    </div>
  );
}

