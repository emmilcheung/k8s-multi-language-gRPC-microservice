import Link from "next/link";
import { ArrowRight, Ticket } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export default function OrderNotFound() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
        Error 404 · order not found
      </p>
      <Card>
        <CardContent className="flex flex-col gap-4 px-8 py-16 text-center">
          <span className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-dashed border-line bg-subtle text-mute">
            <Ticket className="size-7" />
          </span>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-ink">We can&apos;t find this order</h1>
            <p className="mx-auto max-w-xl text-sm leading-6 text-mute">
              This order may have expired, been cancelled, or the link is no longer valid. Open your orders
              list to keep going.
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
