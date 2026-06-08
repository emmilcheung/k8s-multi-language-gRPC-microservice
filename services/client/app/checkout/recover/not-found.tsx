import Link from "next/link";
import { ArrowRight, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export default function CheckoutRecoverNotFound() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-8">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-8 py-16 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl border border-dashed border-line bg-subtle text-mute">
            <AlertCircle className="size-7" />
          </span>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-ink">Recovery details are unavailable</h1>
            <p className="max-w-xl text-sm leading-6 text-mute">
              The expired checkout session may already be gone. Head back to your orders or the event page to
              start a fresh purchase flow.
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
