// app/orders/loading.tsx — Suspense skeleton for the My Orders list page.

import { Skeleton } from "@/components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-28" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass rounded-2xl border-l-4 border-l-border flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-7 w-20" />
            </div>
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-7 w-28 mt-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
