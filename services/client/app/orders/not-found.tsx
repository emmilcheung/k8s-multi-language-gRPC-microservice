import Link from "next/link";
import { ArrowRight, ShoppingBag } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export default function OrdersNotFound() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-8">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          Tickets &amp; orders
        </p>
        <h1 className="text-[28px] font-semibold tracking-[-0.022em] text-ink">My orders</h1>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-8 py-16 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl border border-dashed border-line bg-subtle text-mute">
            <ShoppingBag className="size-7" />
          </span>
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight text-ink">We couldn&apos;t find that order view</h2>
            <p className="max-w-xl text-sm leading-6 text-mute">
              The link may be old or the order has already moved to a different state. Open your latest
              orders list and start again from there.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/orders" className={cn(buttonVariants({ variant: "primary" }), "gap-2")}>
              Open my orders
              <ArrowRight className="size-4" />
            </Link>
            <Link href="/" className={buttonVariants({ variant: "ghost" })}>
              Browse events
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
